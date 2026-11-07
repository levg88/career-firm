/**
 * @file FirmService: the tailoring pipeline orchestrator.
 *
 * Coordinates import, job analysis, CV writing, and rendering into a single
 * end-to-end {@link FirmService.tailor} workflow with status tracking.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Headhunter, OfficeManager, ResumeWriter } from '../agents';
import { Settings } from '../config';
import * as db from '../db';
import { detectLanguage, parseCvHeuristic } from '../documents/heuristics';
import { renderCv } from '../documents/render';
import { buildLlm } from '../llm';
import { parsedCvSchema, type JobAnalysis, type ParsedCV } from '../models';

function slug(value: string, fallback = 'cv'): string {
  const cleaned = (value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 100) || fallback;
}

function stamp(): string {
  const d = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

export interface ImportCvOptions {
  profileId: number;
  vertical: string;
  filename: string;
  filePath: string;
  mime: string;
  rawText: string;
}

export interface TailorResult {
  job_id: number;
  workflow_id: number;
  analysis_id: number;
  generated_id: number;
  score: number;
  docx_path: string;
  pdf_path: string;
  warnings: string[];
}

/** The dedicated career-firm workflow: import → analyse → write → render. */
export class FirmService {
  settings: Settings;
  llm: ReturnType<typeof buildLlm>;
  office: OfficeManager;
  headhunter: Headhunter;
  writer: ResumeWriter;

  constructor(settings: Settings) {
    this.settings = settings;
    this.llm = buildLlm(settings);
    this.office = new OfficeManager(settings, this.llm);
    this.headhunter = new Headhunter(settings, this.llm);
    this.writer = new ResumeWriter(settings, this.llm);
  }

  /**
   * Import a CV: parse it and persist the version.
   * @returns The new CV id, row, and parsed record.
   */
  async importCv(options: ImportCvOptions): Promise<Record<string, any>> {
    const parsed = await this.office.parseCv(options.rawText, { filename: options.filename });
    const cvId = db.withSession(this.settings.dbPath, (conn) => {
      const id = db.addCv(conn, {
        profileId: options.profileId,
        vertical: options.vertical,
        filename: options.filename,
        filePath: options.filePath,
        mime: options.mime,
        rawText: options.rawText,
        structuredJson: JSON.stringify(parsed),
      });
      return id;
    });
    const cv = db.withSession(this.settings.dbPath, (conn) => db.getCv(conn, cvId));
    return { id: cvId, cv, parsed };
  }

  /** Persist the client context text for a profile. */
  setContext(options: { profileId: number; text: string; filename: string | null }): void {
    db.withSession(this.settings.dbPath, (conn) => {
      db.updateProfileContext(conn, options.profileId, options.text, options.filename);
    });
  }

  /**
   * Run the full tailoring pipeline for a job and return the result.
   */
  async tailor(jobId: number): Promise<TailorResult> {
    const now = db.now();
    let job: db.Row | null;
    let profile: db.Row | null;
    let cvs: db.Row[];
    let workflowId: number;

    ({ job, profile, cvs, workflowId } = db.withSession(this.settings.dbPath, (conn) => {
      const foundJob = db.getJob(conn, jobId);
      if (!foundJob) throw new Error(`Job ${jobId} not found`);
      const profileId = Number(foundJob.profile_id || 1);
      const foundProfile = db.getProfile(conn, profileId);
      const foundCvs = db.listCvs(conn, profileId);
      const id = db.createWorkflow(
        conn,
        'tailor',
        `${foundJob.title || 'Role'} @ ${foundJob.company || 'Company'}`,
        { job_id: jobId },
        path.join(this.settings.runsDir, `tailor_${jobId}`),
      );
      db.updateWorkflow(conn, id, { status: 'running' });
      db.updateJob(conn, jobId, { status: 'analyzing', error: null });
      return { job: foundJob, profile: foundProfile, cvs: foundCvs, workflowId: id };
    }));

    const workspace = path.join(this.settings.runsDir, `tailor_${jobId}`);
    fs.mkdirSync(workspace, { recursive: true });

    try {
      if (!cvs!.length) {
        throw new Error('No CV versions are configured. Import at least one CV first.');
      }
      const contextText = profile?.context_text ?? '';
      const requestedLanguage =
        job!.language || detectLanguage(job!.description) || this.settings.defaultLanguage;

      let analysis: JobAnalysis = await this.headhunter.analyze({
        jobDescription: job!.description,
        context: contextText,
        cvs: cvs!,
        fallbackTitle: job!.title,
        fallbackCompany: job!.company,
        language: requestedLanguage,
        workflowRunId: workflowId!,
      });

      const selectedCv =
        cvs!.find((cv) => Number(cv.id) === Number(analysis.recommended_cv_id ?? -1)) ?? cvs![0];
      if (!analysis.recommended_cv_id) {
        analysis = { ...analysis, recommended_cv_id: Number(selectedCv.id) };
      }
      if (!analysis.recommended_vertical) {
        analysis = { ...analysis, recommended_vertical: selectedCv.vertical ?? '' };
      }

      const analysisId = db.withSession(this.settings.dbPath, (conn) => {
        db.updateJob(conn, jobId, {
          title: job!.title || analysis.job_title,
          company: job!.company || analysis.company,
          status: 'writing',
        });
        return db.saveAnalysis(
          conn,
          jobId,
          Number(selectedCv.id),
          analysis.match_score,
          `${analysis.match_level} (${analysis.match_score}/100)`,
          analysis,
        );
      });

      const parsed = this.parsedCv(selectedCv);
      const language = job!.language || analysis.language || this.settings.defaultLanguage;
      const [tailored, warnings] = await this.writer.write({
        analysis,
        parsed,
        sourceText: selectedCv.raw_text ?? '',
        context: contextText,
        language,
        workflowRunId: workflowId!,
      });

      db.withSession(this.settings.dbPath, (conn) => {
        db.updateJob(conn, jobId, { status: 'rendering' });
      });

      const outDir = path.join(this.settings.storageDir, 'generated', `job_${jobId}`);
      const basename = [
        slug(tailored.name || 'candidate', 'candidate'),
        slug(analysis.company || 'company', 'company'),
        slug(analysis.job_title || `job-${jobId}`, 'role'),
        stamp(),
      ]
        .filter(Boolean)
        .join('_');
      const rendered = await renderCv(tailored, outDir, basename, {
        fontPath: this.settings.fontPath || null,
      });

      const generatedId = db.withSession(this.settings.dbPath, (conn) => {
        const id = db.saveGeneratedCv(conn, {
          jobId,
          analysisId,
          language,
          docxPath: rendered.docx_path,
          pdfPath: rendered.pdf_path,
          content: tailored,
          warnings,
        });
        db.updateJob(conn, jobId, { status: 'done', error: null });
        db.updateWorkflow(conn, workflowId!, {
          status: 'done',
          output_json: JSON.stringify({
            job_id: jobId,
            analysis_id: analysisId,
            generated_id: id,
            score: analysis.match_score,
            docx_path: rendered.docx_path,
            pdf_path: rendered.pdf_path,
            warnings,
          }),
          finished_at: now,
        });
        return id;
      });

      return {
        job_id: jobId,
        workflow_id: workflowId!,
        analysis_id: analysisId,
        generated_id: generatedId,
        score: analysis.match_score,
        docx_path: rendered.docx_path,
        pdf_path: rendered.pdf_path,
        warnings,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = `${err.name}: ${err.message}`;
      db.withSession(this.settings.dbPath, (conn) => {
        db.updateJob(conn, jobId, { status: 'failed', error: message });
        db.updateWorkflow(conn, workflowId!, {
          status: 'failed',
          error: message,
          finished_at: now,
        });
      });
      throw error;
    }
  }

  private parsedCv(cv: db.Row): ParsedCV {
    const raw = cv.structured_json;
    if (raw) {
      try {
        const candidate = parsedCvSchema.parse(JSON.parse(String(raw)));
        if (candidate.name || candidate.experience.length) return candidate;
      } catch {
        // Fall through to the deterministic parser.
      }
    }
    return parseCvHeuristic(
      cv.raw_text ?? '',
      path.parse(String(cv.filename ?? '')).name,
    );
  }
}
