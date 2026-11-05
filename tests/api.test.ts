import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app';
import { delay, makeSettings, SAMPLE_CV, SAMPLE_JD } from './helpers';

async function waitForJob(
  agent: request.Agent,
  jobId: number,
  timeoutMs = 20000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> = {};
  while (Date.now() < deadline) {
    const response = await agent.get(`/jobs/${jobId}/status`);
    expect(response.status).toBe(200);
    last = response.body;
    if (last.status === 'done' || last.status === 'failed') return last;
    await delay(50);
  }
  throw new Error(`Job ${jobId} did not finish: ${JSON.stringify(last)}`);
}

describe('web app', () => {
  it('renders every page', async () => {
    const app = createApp(makeSettings());
    const agent = request(app);
    for (const path of ['/', '/profile', '/jobs', '/jobs/new', '/runs', '/settings']) {
      const response = await agent.get(path);
      expect(response.status).toBe(200);
    }
    const health = await agent.get('/health');
    expect(health.body.ok).toBe(true);
    expect(health.body.provider).toBe('mock');
  });

  it('imports a CV and tailors a job through uploads', async () => {
    const app = createApp(makeSettings());
    const agent = request(app);

    const context = await agent
      .post('/profile/context')
      .type('form')
      .send({ text: 'Executive engineering leader focused on AI platforms.' });
    expect(context.status).toBe(303);

    const upload = await agent
      .post('/profile/cvs')
      .field('vertical', 'AI Platforms')
      .attach('file', Buffer.from(SAMPLE_CV), {
        filename: 'jane.md',
        contentType: 'text/markdown',
      });
    expect(upload.status).toBe(303);

    const created = await agent
      .post('/jobs')
      .field('description', SAMPLE_JD)
      .field('title', 'VP Engineering')
      .field('company', 'Nimbus AI')
      .field('language', 'en');
    expect(created.status).toBe(303);
    expect(created.headers.location).toBe('/jobs/1');

    const status = await waitForJob(agent, 1);
    expect(status.status).toBe('done');
    expect(status.generated).toHaveLength(1);

    const jobPage = await agent.get('/jobs/1');
    expect(jobPage.status).toBe(200);
    expect(jobPage.text).toContain('Download PDF');
    expect(jobPage.text).toContain('Headhunter analysis');

    const pdf = await agent.get('/generated/1/download/pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.length).toBeGreaterThan(1000);

    const docx = await agent.get('/generated/1/download/docx');
    expect(docx.status).toBe(200);
    expect(docx.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(Number(docx.headers['content-length'])).toBeGreaterThan(1000);

    expect((await agent.get('/generated/1/download/exe')).status).toBe(400);
    expect((await agent.get('/generated/999/download/pdf')).status).toBe(404);
  });

  it('rejects unsupported uploads', async () => {
    const app = createApp(makeSettings());
    const response = await request(app)
      .post('/profile/cvs')
      .field('vertical', 'X')
      .attach('file', Buffer.from('nope'), {
        filename: 'evil.exe',
        contentType: 'application/octet-stream',
      });
    expect(response.status).toBe(400);
    expect(response.text).toContain('Unsupported file type');
  });

  it('returns 404 for unknown jobs', async () => {
    const app = createApp(makeSettings());
    const response = await request(app).get('/jobs/999');
    expect(response.status).toBe(404);
  });
});
