/**
 * @file Headhunter agent: decodes a job description and scores the candidate match.
 *
 * The {@link Headhunter} class analyses a job posting against the client's CVs
 * and context, producing a {@link JobAnalysis}. Supports both LLM-backed and
 * deterministic heuristic (offline) modes with automatic fallback.
 */

import { Settings } from '../config';
import { analyzeJobHeuristic, candidateDigest } from '../documents/heuristics';
import { LLMClient } from '../llm/base';
import { MockClient } from '../llm/mock';
import { jobAnalysisSchema, type JobAnalysis } from '../models';
import { agentFromDefinition } from './base';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { recordHeuristicRun, runAgent } from './runner';
import { schemaForAgent } from './schema';

/**
 * Options for {@link Headhunter.analyze}.
 */
export interface AnalyzeOptions {
  jobDescription: string;
  context: string;
  cvs: Record<string, any>[];
  fallbackTitle?: string;
  fallbackCompany?: string;
  language?: string;
  workflowRunId?: number | null;
}

/**
 * Reads the job like a hiring committee and maps evidence to requirements.
 * Wraps either an LLM-backed analysis or the deterministic heuristic fallback.
 */
export class Headhunter {
  readonly definition: AgentDefinition;
  readonly role: string;
  settings: Settings;
  llm: LLMClient;

  constructor(settings: Settings, llm: LLMClient) {
    this.settings = settings;
    this.llm = llm;
    this.definition = getAgentDefinition('headhunter', { extraDirs: [settings.agentsDir] });
    this.role = this.definition.role;
  }

  /**
   * Analyse a job description and return a normalised {@link JobAnalysis}.
   * @param options Analysis inputs including job text, context, and CVs.
   */
  async analyze(options: AnalyzeOptions): Promise<JobAnalysis> {
    const {
      jobDescription,
      context,
      cvs,
      fallbackTitle = '',
      fallbackCompany = '',
      language = 'en',
      workflowRunId = null,
    } = options;
    const digest = candidateDigest(context, cvs);

    if (this.settings.isMock || this.llm instanceof MockClient) {
      const analysis = analyzeJobHeuristic(
        jobDescription,
        digest,
        cvs,
        fallbackTitle,
        fallbackCompany,
      );
      recordHeuristicRun(this.settings, {
        workflow: 'tailoring',
        role: this.role,
        inputPayload: {
          job_chars: jobDescription.length,
          cv_ids: cvs.map((cv) => cv.id),
        },
        output: analysis as unknown as Record<string, unknown>,
        workflowRunId,
      });
      return this.normalise(analysis, cvs, fallbackTitle, fallbackCompany, language);
    }

    const inventory = cvs
      .map((cv) => `- CV ID ${cv.id} | vertical: ${cv.vertical ?? ''} | file: ${cv.filename ?? ''}`)
      .join('\n');
    const task = renderAgentTask(this.definition, {
      job_description: jobDescription.trim(),
      cv_inventory: inventory || '(no CVs imported)',
      language,
    });

    const agent = agentFromDefinition(this.definition, this.llm, this.settings);

    let analysis: JobAnalysis;
    try {
      const result = await runAgent(this.settings, agent, {
        workflow: this.definition.workflow,
        role: this.role,
        task,
        context: digest,
        schema: schemaForAgent(this.definition),
        workflowRunId,
      });
      analysis = jobAnalysisSchema.parse(result.data ?? {});
    } catch (error) {
      if (!this.settings.allowHeuristicFallback) throw error;
      analysis = analyzeJobHeuristic(
        jobDescription,
        digest,
        cvs,
        fallbackTitle,
        fallbackCompany,
      );
      const err = error instanceof Error ? error : new Error(String(error));
      analysis = {
        ...analysis,
        analyzer_notes: `${analysis.analyzer_notes} Model analysis failed (${err.name}); heuristic fallback used.`.trim(),
      };
    }

    return this.normalise(analysis, cvs, fallbackTitle, fallbackCompany, language);
  }

  /**
   * Normalise the analysis: fill fallbacks, clamp score, ensure recommended CV.
   */
  private normalise(
    analysis: JobAnalysis,
    cvs: Record<string, any>[],
    fallbackTitle: string,
    fallbackCompany: string,
    language: string,
  ): JobAnalysis {
    const updates: Partial<JobAnalysis> = {};
    if (!analysis.job_title) updates.job_title = fallbackTitle;
    if (!analysis.company) updates.company = fallbackCompany;
    if (!analysis.language) updates.language = language;

    const ids = new Set(cvs.map((cv) => Number(cv.id)));
    if (analysis.recommended_cv_id === null || !ids.has(Number(analysis.recommended_cv_id))) {
      updates.recommended_cv_id = cvs.length ? Number(cvs[0].id) : null;
    }
    const chosenId = updates.recommended_cv_id ?? analysis.recommended_cv_id;
    const chosen = cvs.find((cv) => Number(cv.id) === Number(chosenId)) ?? null;
    if (chosen && !analysis.recommended_vertical) {
      updates.recommended_vertical = chosen.vertical ?? '';
    }

    const score = Math.max(0, Math.min(100, Math.trunc(Number(analysis.match_score) || 0)));
    updates.match_score = score;
    if (!analysis.match_level) {
      updates.match_level = score >= 75 ? 'strong' : score >= 50 ? 'moderate' : 'weak';
    }
    if (!analysis.do_not_claim.length) {
      updates.do_not_claim = analysis.gaps.map((gap) => gap.requirement).filter(Boolean);
    }
    return { ...analysis, ...updates };
  }
}
