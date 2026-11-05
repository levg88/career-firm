import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { extractText } from '../src/documents/extract';
import { FirmService } from '../src/orchestrator/firm';
import { makeSettings, profileId as getProfileId, SAMPLE_CV, SAMPLE_JD } from './helpers';

function freshDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-pipeline-'));
}

async function importSampleCv(
  service: FirmService,
  profileId: number,
  directory: string,
): Promise<Record<string, any>> {
  return service.importCv({
    profileId,
    vertical: 'AI Platforms',
    filename: 'jane.md',
    filePath: path.join(directory, 'jane.md'),
    mime: 'text/markdown',
    rawText: SAMPLE_CV,
  });
}

describe('firm pipeline', () => {
  it('runs import → analyse → write → render end to end', async () => {
    const settings = makeSettings({ provider: 'mock' });
    const profileId = getProfileId(settings);
    const directory = freshDirectory();

    const jobId = db.withSession(settings.dbPath, (conn) => {
      db.updateProfileContext(
        conn,
        profileId,
        'Executive engineering leader focused on AI platforms.',
        'context.md',
      );
      return db.createJob(conn, {
        profileId,
        title: 'VP Engineering',
        company: 'Nimbus AI',
        description: SAMPLE_JD,
        language: 'en',
      });
    });

    const service = new FirmService(settings);
    const imported = await importSampleCv(service, profileId, directory);
    expect(imported.id).toBe(1);
    expect(imported.parsed.name).toBe('Jane Doe');

    const result = await service.tailor(jobId);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(fs.existsSync(result.pdf_path)).toBe(true);
    expect(fs.existsSync(result.docx_path)).toBe(true);
    expect(result.warnings).toEqual([]);

    const snapshot = db.withSession(settings.dbPath, (conn) => ({
      job: db.getJob(conn, jobId),
      analysis: db.latestAnalysis(conn, jobId),
      generated: db.listGenerated(conn, jobId),
      workflow: db.getWorkflow(conn, result.workflow_id),
    }));
    expect(snapshot.job?.status).toBe('done');
    expect(snapshot.job?.error).toBeNull();
    expect(snapshot.analysis?.score).toBe(result.score);
    expect((snapshot.analysis?.data.strengths ?? []).length).toBeGreaterThanOrEqual(1);
    expect(snapshot.generated).toHaveLength(1);
    expect(snapshot.generated[0].warnings).toEqual([]);
    expect(snapshot.workflow?.status).toBe('done');

    const pdfText = await extractText(result.pdf_path);
    expect(pdfText).toContain('Jane Doe');
    expect(pdfText).toContain('Acme Corp');
    expect(pdfText).not.toContain('Nimbus AI');
  });

  it('matches the posting language when none is requested', async () => {
    const settings = makeSettings({ provider: 'mock' });
    const profileId = getProfileId(settings);
    const directory = freshDirectory();
    const russianJd =
      'Директор по инженерии\n' +
      'Компания: Аврора\n\n' +
      'Требуется опыт руководства инженерными командами и работа с облачными платформами.\n' +
      'Обязанности: развитие платформы и масштабирование команды.\n';

    const jobId = db.withSession(settings.dbPath, (conn) => {
      db.updateProfileContext(conn, profileId, 'Engineering executive.', 'context.md');
      return db.createJob(conn, {
        profileId,
        title: '',
        company: '',
        description: russianJd,
        language: '',
      });
    });

    const service = new FirmService(settings);
    await importSampleCv(service, profileId, directory);
    const result = await service.tailor(jobId);

    const generated = db.withSession(settings.dbPath, (conn) => db.listGenerated(conn, jobId));
    expect(generated[0].language).toBe('ru');
    expect(fs.existsSync(result.pdf_path)).toBe(true);
  });

  it('fails clearly when no CV version is configured', async () => {
    const settings = makeSettings({ provider: 'mock' });
    const profileId = getProfileId(settings);
    const jobId = db.withSession(settings.dbPath, (conn) =>
      db.createJob(conn, {
        profileId,
        title: 'VP',
        company: 'Nimbus',
        description: SAMPLE_JD,
        language: 'en',
      }),
    );

    const service = new FirmService(settings);
    await expect(service.tailor(jobId)).rejects.toThrow('No CV versions');
    const job = db.withSession(settings.dbPath, (conn) => db.getJob(conn, jobId));
    expect(job?.status).toBe('failed');
  });
});
