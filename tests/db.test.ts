import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import {
  analyzeJobHeuristic,
  parseCvHeuristic,
  tailorHeuristic,
} from '../src/documents/heuristics';
import { renderCv } from '../src/documents/render';
import { makeSettings, profileId as getProfileId, SAMPLE_CV, SAMPLE_JD } from './helpers';

describe('repository', () => {
  it('round-trips every durable record', async () => {
    const settings = makeSettings();
    const profileId = getProfileId(settings);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-db-'));
    const parsed = parseCvHeuristic(SAMPLE_CV);
    const analysis = analyzeJobHeuristic(SAMPLE_JD, SAMPLE_CV);
    const tailored = tailorHeuristic(parsed, analysis, SAMPLE_CV, 'leader');
    const rendered = await renderCv(tailored, directory, 'out');

    const ids = db.withSession(settings.dbPath, (conn) => {
      const cvId = db.addCv(conn, {
        profileId,
        vertical: 'AI Platforms',
        filename: 'jane.docx',
        filePath: path.join(directory, 'jane.docx'),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        rawText: SAMPLE_CV,
        structuredJson: JSON.stringify(parsed),
      });
      const jobId = db.createJob(conn, {
        profileId,
        title: 'VP Engineering',
        company: 'Nimbus AI',
        description: SAMPLE_JD,
        language: 'en',
      });
      const analysisId = db.saveAnalysis(
        conn,
        jobId,
        cvId,
        analysis.match_score,
        analysis.match_level,
        analysis,
      );
      const genId = db.saveGeneratedCv(conn, {
        jobId,
        analysisId,
        language: 'en',
        docxPath: rendered.docx_path,
        pdfPath: rendered.pdf_path,
        content: tailored,
        warnings: [],
      });
      const workflowId = db.createWorkflow(conn, 'tailor', 'test', { job_id: jobId });
      const runId = db.startAgentRun(
        conn,
        workflowId,
        'tailoring',
        'headhunter',
        { task: 'x' },
        'mock',
        'mock',
      );
      db.finishAgentRun(conn, runId, 'ok', { score: 80 }, undefined, 1, 2);
      db.saveArtifact(conn, workflowId, runId, 'a.md', 'markdown', 'hello');
      return { cvId, jobId, analysisId, genId, workflowId };
    });

    const snapshot = db.withSession(settings.dbPath, (conn) => ({
      cv: db.getCv(conn, ids.cvId),
      job: db.getJob(conn, ids.jobId),
      analysis: db.latestAnalysis(conn, ids.jobId),
      generated: db.listGenerated(conn, ids.jobId),
      runs: db.listAgentRuns(conn, ids.workflowId),
      artifacts: db.listArtifacts(conn, ids.workflowId),
      stats: db.stats(conn),
      generatedOne: db.getGenerated(conn, ids.genId),
    }));

    expect(snapshot.cv?.vertical).toBe('AI Platforms');
    expect(snapshot.job?.status).toBe('queued');
    expect(snapshot.analysis?.score).toBe(analysis.match_score);
    expect(snapshot.generated).toHaveLength(1);
    expect(snapshot.runs[0].status).toBe('ok');
    expect(snapshot.runs[0].prompt_tokens).toBe(1);
    expect(snapshot.artifacts[0].content).toBe('hello');
    expect(snapshot.stats.cv_versions).toBe(1);
    expect(snapshot.stats.jobs).toBe(1);
    expect(snapshot.stats.generated_cvs).toBe(1);
    expect(snapshot.generatedOne?.warnings).toEqual([]);
  });

  it('deactivates CV versions', () => {
    const settings = makeSettings();
    const profileId = getProfileId(settings);
    const cvId = db.withSession(settings.dbPath, (conn) =>
      db.addCv(conn, {
        profileId,
        vertical: 'X',
        filename: 'x.md',
        filePath: '/tmp/x.md',
        mime: 'text/markdown',
        rawText: 'x',
      }),
    );
    expect(db.withSession(settings.dbPath, (conn) => db.listCvs(conn, profileId))).toHaveLength(1);
    db.withSession(settings.dbPath, (conn) => db.deactivateCv(conn, cvId));
    expect(db.withSession(settings.dbPath, (conn) => db.listCvs(conn, profileId))).toHaveLength(0);
    expect(
      db.withSession(settings.dbPath, (conn) => db.listCvs(conn, profileId, false)),
    ).toHaveLength(1);
  });
});
