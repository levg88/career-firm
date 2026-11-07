import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { Settings, defaultBaseUrlFor, defaultModelFor } from '../config';
import * as db from '../db';
import { ExtractionError, extractText } from '../documents/extract';
import { buildLlm } from '../llm';
import { MockClient } from '../llm/mock';
import { FirmService } from '../orchestrator/firm';
import {
  applyStoredSettings,
  isProviderName,
  mimeFor,
  safeFilename,
} from '../runtime';

export const ALLOWED_UPLOADS = new Set(['.docx', '.pdf', '.txt', '.md', '.markdown']);

const PROVIDERS: Array<[string, string]> = [
  ['openai', 'OpenAI / OpenAI-compatible'],
  ['anthropic', 'Anthropic'],
  ['ollama', 'Ollama (local)'],
  ['opencode', 'OpenCode (free & paid models)'],
  ['mock', 'Offline mode (no key)'],
];

function saveUpload(
  settings: Settings,
  subdir: string,
  name: string,
  data: Buffer,
): string {
  const directory = path.join(settings.storageDir, subdir);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(
    directory,
    `${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}_${safeFilename(name)}`,
  );
  fs.writeFileSync(target, data);
  return target;
}

function uploadFiles(req: Request): Express.Multer.File[] {
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return Object.values(req.files).flat();
  }
  return [];
}

function uploadedFile(req: Request, field: string): Express.Multer.File | undefined {
  return uploadFiles(req).find((file) => file.fieldname === field);
}

function readUpload(
  file: Express.Multer.File,
  settings: Settings,
): { name: string; data: Buffer } {
  const name = file.originalname || 'upload';
  const suffix = path.extname(name).toLowerCase();
  if (!ALLOWED_UPLOADS.has(suffix)) {
    throw new Error(
      `Unsupported file type '${suffix || 'unknown'}'. Use DOCX, PDF, TXT, or Markdown.`,
    );
  }
  const data = file.buffer;
  if (!data.length) throw new Error('The uploaded file is empty.');
  if (data.length > settings.maxUploadMb * 1024 * 1024) {
    throw new Error(`File exceeds the ${settings.maxUploadMb} MB limit.`);
  }
  return { name, data };
}

function llmNote(settings: Settings): string {
  let llm;
  try {
    llm = buildLlm(settings);
  } catch {
    return '';
  }
  if (llm instanceof MockClient) {
    if (llm.reason) {
      return `Offline mode: ${llm.reason}. Open Settings to choose a provider.`;
    }
    return (
      'Offline mode. CVs are being tailored with deterministic rules. ' +
      'Open Settings to add a provider and API key.'
    );
  }
  return '';
}

function profileRow(settings: Settings): db.Row {
  return db.withSession(settings.dbPath, (conn) => db.getOrCreateProfile(conn));
}

function currentBaseUrl(settings: Settings): string {
  return settings.activeBaseUrl;
}

function bodyString(req: Request, key: string): string {
  const value = (req.body ?? {})[key];
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

function bodyBool(req: Request, key: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(bodyString(req, key).trim().toLowerCase());
}

function queryString(req: Request, key: string): string {
  const value = req.query[key];
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

async function runTailor(settings: Settings, jobId: number): Promise<void> {
  try {
    await new FirmService(settings).tailor(jobId);
  } catch {
    // The service records the failure on the job and workflow.
  }
}

export function createApp(initialSettings?: Settings): express.Express {
  const settings = initialSettings ?? Settings.load();
  settings.ensureDirs();
  applyStoredSettings(settings);

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');

  const root = path.resolve(__dirname, '..', '..');
  app.set('views', path.join(root, 'views'));
  app.use('/static', express.static(path.join(root, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  // Every page is gated until setup is finished.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestPath = req.path;
    if (
      !settings.setupComplete &&
      !['/setup', '/health', '/favicon.ico'].includes(requestPath) &&
      !requestPath.startsWith('/static/')
    ) {
      res.redirect(303, '/setup');
      return;
    }
    next();
  });

  function page(
    res: Response,
    name: string,
    extras: Record<string, any> = {},
    statusCode = 200,
  ): void {
    const profile = profileRow(settings);
    const cvs = db.withSession(settings.dbPath, (conn) => db.listCvs(conn, Number(profile.id)));
    const stats = db.withSession(settings.dbPath, (conn) => db.stats(conn));
    res.status(statusCode).render(name, {
      profile,
      cv_count: cvs.length,
      stats,
      llm_note: llmNote(settings),
      settings,
      active: '',
      error: '',
      message: '',
      ...extras,
    });
  }

  function setupPage(
    res: Response,
    options: { editing: boolean; error?: string; message?: string; statusCode?: number },
  ): void {
    const profile = profileRow(settings);
    const cvs = db.withSession(settings.dbPath, (conn) =>
      db.listCvs(conn, Number(profile.id), false),
    );
    page(
      res,
      'setup',
      {
        editing: options.editing,
        cvs,
        base_url: currentBaseUrl(settings),
        providers: PROVIDERS,
        suggested_models: Object.fromEntries(
          ['openai', 'anthropic', 'ollama', 'opencode', 'mock'].map((provider) => [
            provider,
            defaultModelFor(provider),
          ]),
        ),
        suggested_base_urls: Object.fromEntries(
          ['openai', 'anthropic', 'ollama', 'opencode'].map((provider) => [
            provider,
            defaultBaseUrlFor(provider),
          ]),
        ),
        error: options.error ?? '',
        message: options.message ?? '',
        active: 'settings',
        llm_note: '',
      },
      options.statusCode ?? 200,
    );
  }

  function profilePage(
    res: Response,
    options: { error?: string; message?: string; statusCode?: number } = {},
  ): void {
    const profile = profileRow(settings);
    const cvs = db.withSession(settings.dbPath, (conn) =>
      db.listCvs(conn, Number(profile.id), false),
    );
    page(
      res,
      'profile',
      {
        cvs,
        error: options.error ?? '',
        message: options.message ?? '',
        active: 'profile',
      },
      options.statusCode ?? 200,
    );
  }

  // ── setup / settings ────────────────────────────────────────────────────────
  app.get('/setup', (req, res) => {
    setupPage(res, {
      editing: settings.setupComplete,
      message: queryString(req, 'message'),
      error: queryString(req, 'error'),
    });
  });

  app.get('/settings', (req, res) => {
    setupPage(res, {
      editing: true,
      message: queryString(req, 'message'),
      error: queryString(req, 'error'),
    });
  });

  app.post(['/setup', '/settings'], upload.any(), async (req, res) => {
    const editing = settings.setupComplete;
    const provider = bodyString(req, 'provider').trim().toLowerCase() || 'mock';
    if (!isProviderName(provider)) {
      setupPage(res, { editing, error: 'Choose a valid provider.' });
      return;
    }

    const keyCleared = bodyBool(req, 'clear_key');
    const enteredKey = keyCleared ? '' : bodyString(req, 'api_key').trim();
    const existingKey =
      provider === 'anthropic'
        ? settings.anthropicApiKey
        : provider === 'opencode'
          ? settings.opencodeApiKey
          : settings.apiKey;
    const effectiveKey = enteredKey || existingKey;

    if (provider === 'openai' && !effectiveKey) {
      setupPage(res, {
        editing,
        error:
          'An OpenAI API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }
    if (provider === 'anthropic' && !effectiveKey) {
      setupPage(res, {
        editing,
        error:
          'An Anthropic API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }
    if (provider === 'opencode' && !effectiveKey) {
      setupPage(res, {
        editing,
        error:
          'An OpenCode API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }

    const ollamaBaseUrl = bodyString(req, 'ollama_base_url').trim();
    const opencodeBaseUrl = bodyString(req, 'opencode_base_url').trim();
    const ollamaModel = bodyString(req, 'ollama_model').trim();
    const opencodeModel = bodyString(req, 'opencode_model').trim();
    const opencodeApiKey = bodyString(req, 'opencode_api_key').trim();

    let resolvedBase = bodyString(req, 'base_url').trim() || defaultBaseUrlFor(provider);
    let resolvedModel = bodyString(req, 'model').trim() || defaultModelFor(provider);

    // Use provider-specific values if provided
    if (provider === 'ollama') {
      if (ollamaBaseUrl) resolvedBase = ollamaBaseUrl;
      if (ollamaModel) resolvedModel = ollamaModel;
    } else if (provider === 'opencode') {
      if (opencodeBaseUrl) resolvedBase = opencodeBaseUrl;
      if (opencodeModel) resolvedModel = opencodeModel;
    }

    const updates: Record<string, string> = {
      provider,
      model: resolvedModel || defaultModelFor(provider),
      default_language: bodyString(req, 'default_language').trim() || 'en',
      temperature: bodyString(req, 'temperature'),
      max_tokens: bodyString(req, 'max_tokens'),
      max_agent_steps: bodyString(req, 'max_agent_steps'),
      max_upload_mb: bodyString(req, 'max_upload_mb'),
      allow_heuristic_fallback: bodyBool(req, 'allow_heuristic_fallback') ? 'true' : 'false',
      font_path: bodyString(req, 'font_path').trim(),
    };
    if (provider === 'anthropic') {
      updates.anthropic_base_url = resolvedBase;
    } else if (provider === 'ollama') {
      updates.ollama_base_url = resolvedBase;
    } else if (provider === 'opencode') {
      updates.opencode_base_url = resolvedBase;
    } else {
      updates.base_url = resolvedBase;
    }

    if (keyCleared) {
      updates.api_key = '';
      updates.anthropic_api_key = '';
      updates.opencode_api_key = '';
    } else if (enteredKey) {
      if (provider === 'anthropic') updates.anthropic_api_key = enteredKey;
      else if (provider === 'opencode') updates.opencode_api_key = enteredKey;
      else if (provider === 'openai' || provider === 'ollama') updates.api_key = enteredKey;
    } else if (provider === 'opencode' && opencodeApiKey) {
      updates.opencode_api_key = opencodeApiKey;
    }
    // Always save ollama/opencode base URLs if provided
    if (ollamaBaseUrl) updates.ollama_base_url = ollamaBaseUrl;
    if (opencodeBaseUrl) updates.opencode_base_url = opencodeBaseUrl;

    settings.applyConfig(updates);
    settings.setupComplete = true;
    db.withSession(settings.dbPath, (conn) =>
      db.saveAppSettings(conn, settings.configValues({ includeSecrets: true })),
    );

    try {
      const service = new FirmService(settings);
      const contextFile = uploadedFile(req, 'context_file');
      const contextText = bodyString(req, 'context_text');
      if (contextFile && contextFile.originalname) {
        const { name, data } = readUpload(contextFile, settings);
        const filePath = saveUpload(settings, 'context', name, data);
        const raw = await extractText(filePath);
        service.setContext({ profileId: Number(profileRow(settings).id), text: raw, filename: name });
      } else if (contextText.trim()) {
        service.setContext({
          profileId: Number(profileRow(settings).id),
          text: contextText.trim(),
          filename: 'pasted-context',
        });
      }

      const cvFile = uploadedFile(req, 'cv_file');
      if (cvFile && cvFile.originalname) {
        const profile = profileRow(settings);
        const { name, data } = readUpload(cvFile, settings);
        const filePath = saveUpload(settings, `cvs/profile_${profile.id}`, name, data);
        const raw = await extractText(filePath);
        await service.importCv({
          profileId: Number(profile.id),
          vertical: bodyString(req, 'vertical').trim() || path.parse(name).name,
          filename: name,
          filePath,
          mime: mimeFor(name),
          rawText: raw,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setupPage(res, {
        editing,
        error: `Configuration saved, but the upload failed: ${message}`,
      });
      return;
    }

    if (editing) {
      res.redirect(303, '/settings?message=Configuration+saved');
      return;
    }
    res.redirect(303, '/?welcome=1');
  });

  // ── dashboard / health ──────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const jobs = db.withSession(settings.dbPath, (conn) => db.listJobs(conn, 12));
    const message =
      String(req.query.welcome ?? '') === '1'
        ? 'Setup complete. Import another CV version or paste a job description to begin.'
        : '';
    page(res, 'index', { jobs, active: 'home', message });
  });

  app.get('/health', (req, res) => {
    const stats = db.withSession(settings.dbPath, (conn) => db.stats(conn));
    res.json({
      ok: true,
      setup_complete: settings.setupComplete,
      provider: settings.provider,
      model: settings.model,
      stats,
    });
  });

  // ── profile ─────────────────────────────────────────────────────────────────
  app.get('/profile', (req, res) => {
    profilePage(res, {
      message: queryString(req, 'message'),
      error: queryString(req, 'error'),
    });
  });

  app.post('/profile/context', upload.any(), async (req, res) => {
    const profile = profileRow(settings);
    try {
      const file = uploadedFile(req, 'file');
      const text = bodyString(req, 'text');
      if (file && file.originalname) {
        const { name, data } = readUpload(file, settings);
        const filePath = saveUpload(settings, 'context', name, data);
        const raw = await extractText(filePath);
        new FirmService(settings).setContext({
          profileId: Number(profile.id),
          text: raw,
          filename: name,
        });
      } else if (text.trim()) {
        new FirmService(settings).setContext({
          profileId: Number(profile.id),
          text: text.trim(),
          filename: 'pasted-context',
        });
      } else {
        throw new Error('Paste context text or upload a file.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      profilePage(res, { error: message, statusCode: 400 });
      return;
    }
    res.redirect(303, '/profile?message=Context+saved');
  });

  app.post('/profile/cvs', upload.any(), async (req, res) => {
    const profile = profileRow(settings);
    try {
      const file = uploadedFile(req, 'file');
      if (!file || !file.originalname) throw new Error('Choose a CV file to import.');
      const { name, data } = readUpload(file, settings);
      const filePath = saveUpload(settings, `cvs/profile_${profile.id}`, name, data);
      const raw = await extractText(filePath);
      await new FirmService(settings).importCv({
        profileId: Number(profile.id),
        vertical: bodyString(req, 'vertical').trim() || path.parse(name).name,
        filename: name,
        filePath,
        mime: mimeFor(name),
        rawText: raw,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      profilePage(res, { error: message, statusCode: 400 });
      return;
    }
    res.redirect(303, '/profile?message=CV+imported');
  });

  app.post('/profile/linkedin', upload.any(), async (req, res) => {
    const profile = profileRow(settings);
    try {
      const file = uploadedFile(req, 'file');
      if (!file || !file.originalname) throw new Error('Choose a LinkedIn PDF export to import.');
      const { name, data } = readUpload(file, settings);
      const filePath = saveUpload(settings, `cvs/profile_${profile.id}`, name, data);
      const raw = await extractText(filePath);
      await new FirmService(settings).importCv({
        profileId: Number(profile.id),
        vertical: bodyString(req, 'vertical').trim() || 'LinkedIn Export',
        filename: name,
        filePath,
        mime: mimeFor(name),
        rawText: raw,
      });
    } catch (error) {
      const message = error instanceof Error ? error : new Error(String(error));
      profilePage(res, { error: message.message, statusCode: 400 });
      return;
    }
    res.redirect(303, '/profile?message=LinkedIn+profile+imported');
  });

  app.post('/profile/cvs/:cvId/delete', (req, res) => {
    const cvId = Number.parseInt(req.params.cvId, 10);
    if (Number.isFinite(cvId)) {
      db.withSession(settings.dbPath, (conn) => db.deactivateCv(conn, cvId));
    }
    res.redirect(303, '/profile?message=CV+deactivated');
  });

  // ── jobs ────────────────────────────────────────────────────────────────────
  app.get('/jobs', (req, res) => {
    const jobs = db.withSession(settings.dbPath, (conn) => db.listJobs(conn, 200));
    page(res, 'jobs', { jobs, active: 'jobs' });
  });

  app.get('/jobs/new', (req, res) => {
    page(res, 'job_new', { active: 'new' });
  });

  app.post('/jobs', upload.any(), async (req, res) => {
    const profile = profileRow(settings);
    const description = bodyString(req, 'description');
    const title = bodyString(req, 'title');
    const company = bodyString(req, 'company');
    const language = bodyString(req, 'language');
    const jdFile = uploadedFile(req, 'jd_file');

    let jd = description;
    try {
      if (jdFile && jdFile.originalname) {
        const { name, data } = readUpload(jdFile, settings);
        const filePath = saveUpload(settings, `jobs/profile_${profile.id}`, name, data);
        jd = await extractText(filePath);
      }
      if (!jd.trim()) throw new Error('Paste a job description or upload a file.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      page(
        res,
        'job_new',
        {
          error: message,
          form: { description, title, company },
          active: 'new',
        },
        400,
      );
      return;
    }

    const jobId = db.withSession(settings.dbPath, (conn) =>
      db.createJob(conn, {
        profileId: Number(profile.id),
        title: title.trim(),
        company: company.trim(),
        description: jd.trim(),
        source: jdFile && jdFile.originalname ? jdFile.originalname : 'pasted',
        language: language.trim(),
      }),
    );
    setImmediate(() => {
      void runTailor(settings, jobId);
    });
    res.redirect(303, `/jobs/${jobId}`);
  });

  app.get('/jobs/:jobId', (req, res) => {
    const jobId = Number.parseInt(req.params.jobId, 10);
    const detail = db.withSession(settings.dbPath, (conn) => {
      const job = db.getJob(conn, jobId);
      if (!job) return null;
      const analysis = db.latestAnalysis(conn, jobId);
      const generated = db.listGenerated(conn, jobId);
      const workflows = db
        .listWorkflows(conn, 50)
        .filter(
          (workflow) =>
            workflow.kind === 'tailor' && Number(workflow.input?.job_id) === jobId,
        );
      return { job, analysis, generated, workflows };
    });
    if (!detail) {
      res.status(404).send('Job not found');
      return;
    }
    const analysisJson = detail.analysis
      ? JSON.stringify(detail.analysis.data, null, 2)
      : '';
    page(res, 'job_detail', {
      ...detail,
      analysis_json: analysisJson,
      active: 'jobs',
    });
  });

  app.get('/jobs/:jobId/status', (req, res) => {
    const jobId = Number.parseInt(req.params.jobId, 10);
    const data = db.withSession(settings.dbPath, (conn) => {
      const job = db.getJob(conn, jobId);
      if (!job) return null;
      return { job, generated: db.listGenerated(conn, jobId) };
    });
    if (!data) {
      res.status(404).json({ detail: 'Job not found' });
      return;
    }
    res.json({
      id: data.job.id,
      status: data.job.status,
      error: data.job.error,
      generated: data.generated.map((item) => ({
        id: item.id,
        pdf: `/generated/${item.id}/download/pdf`,
        docx: `/generated/${item.id}/download/docx`,
      })),
    });
  });

  app.get('/generated/:generatedId/download/:fmt', (req, res) => {
    const fmt = req.params.fmt;
    if (fmt !== 'pdf' && fmt !== 'docx') {
      res.status(400).send('Format must be pdf or docx');
      return;
    }
    const generatedId = Number.parseInt(req.params.generatedId, 10);
    const generated = db.withSession(settings.dbPath, (conn) =>
      db.getGenerated(conn, generatedId),
    );
    if (!generated) {
      res.status(404).send('Generated CV not found');
      return;
    }
    const filePath = generated[`${fmt}_path`];
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).send('File is missing on disk');
      return;
    }
    res.type(mimeFor(filePath));
    res.download(filePath, path.basename(filePath));
  });

  // ── audit trail ─────────────────────────────────────────────────────────────
  app.get('/runs', (req, res) => {
    const data = db.withSession(settings.dbPath, (conn) => ({
      workflows: db.listWorkflows(conn, 40),
      agent_runs: db.listAgentRuns(conn, null, 80),
    }));
    page(res, 'runs', { ...data, active: 'runs' });
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof multer.MulterError) {
      res.status(400).send(message);
      return;
    }
    res.status(500).send(message);
  });

  return app;
}

export { ExtractionError };
