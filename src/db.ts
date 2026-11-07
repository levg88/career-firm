/**
 * @file Database schema and query helpers.
 *
 * Defines the SQLite schema (profiles, CV versions, jobs, analyses, generated
 * CVs, workflows, agent runs, artifacts, app settings) and all CRUD helpers used
 * by the application, wrapped in transactional sessions.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    context_text TEXT NOT NULL DEFAULT '',
    context_filename TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    vertical TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    raw_text TEXT NOT NULL,
    structured_json TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_profile ON cv_versions(profile_id, is_active);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    cv_version_id INTEGER REFERENCES cv_versions(id) ON DELETE SET NULL,
    score INTEGER NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL DEFAULT '',
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_job ON analyses(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generated_cvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    analysis_id INTEGER REFERENCES analyses(id) ON DELETE SET NULL,
    language TEXT NOT NULL DEFAULT 'en',
    docx_path TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    content_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generated_job ON generated_cvs(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    workspace_path TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_created ON workflow_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error TEXT,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    path TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workflow ON artifacts(workflow_run_id);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
`;

export type Row = Record<string, any>;
export type Conn = Database.Database;

/** Current timestamp in ISO-8601 form (seconds precision). */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Open a SQLite connection with foreign keys enabled. */
export function connect(dbPath: string): Conn {
  const conn = new Database(dbPath, { timeout: 30000 });
  conn.pragma('foreign_keys = ON');
  return conn;
}

/**
 * Run a function inside a transactional session, committing on success and
 * rolling back on error. The connection is closed afterwards.
 */
export function withSession<T>(dbPath: string, fn: (conn: Conn) => T): T {
  const conn = connect(dbPath);
  try {
    conn.exec('BEGIN');
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw error;
  } finally {
    conn.close();
  }
}

/** Create the database file and apply the schema if needed. */
export function initDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = connect(dbPath);
  try {
    conn.exec(SCHEMA);
  } finally {
    conn.close();
  }
}

// ── runtime configuration ────────────────────────────────────────────────────

export function getAppSettings(conn: Conn): Record<string, string> {
  const rows = conn.prepare('SELECT key, value FROM app_settings').all() as Row[];
  const out: Record<string, string> = {};
  for (const row of rows) out[String(row.key)] = String(row.value);
  return out;
}

export function saveAppSettings(conn: Conn, values: Record<string, string>): void {
  const ts = now();
  const stmt = conn.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = excluded.updated_at`,
  );
  for (const [key, value] of Object.entries(values)) {
    stmt.run(key, String(value), ts);
  }
}

export function clearAppSettings(conn: Conn): void {
  conn.prepare('DELETE FROM app_settings').run();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── profiles ─────────────────────────────────────────────────────────────────

export function getOrCreateProfile(conn: Conn, name = 'default'): Row {
  const row = conn.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as Row | undefined;
  if (row) return row;
  const ts = now();
  const info = conn
    .prepare("INSERT INTO profiles (name, context_text, created_at, updated_at) VALUES (?, '', ?, ?)")
    .run(name, ts, ts);
  return conn.prepare('SELECT * FROM profiles WHERE id = ?').get(info.lastInsertRowid) as Row;
}

export function getProfile(conn: Conn, profileId = 1): Row | null {
  const row = conn.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as Row | undefined;
  return row ?? null;
}

export function updateProfileContext(
  conn: Conn,
  profileId: number,
  text: string,
  filename: string | null,
): void {
  conn
    .prepare('UPDATE profiles SET context_text = ?, context_filename = ?, updated_at = ? WHERE id = ?')
    .run(text, filename, now(), profileId);
}

// ── CV versions ──────────────────────────────────────────────────────────────

export interface AddCvInput {
  profileId: number;
  vertical: string;
  filename: string;
  filePath: string;
  mime: string;
  rawText: string;
  structuredJson?: string | null;
}

export function addCv(conn: Conn, input: AddCvInput): number {
  const info = conn
    .prepare(
      `INSERT INTO cv_versions
       (profile_id, vertical, filename, file_path, mime, raw_text, structured_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.profileId,
      input.vertical,
      input.filename,
      input.filePath,
      input.mime,
      input.rawText,
      input.structuredJson ?? null,
      now(),
    );
  return Number(info.lastInsertRowid);
}

export function listCvs(conn: Conn, profileId: number, activeOnly = true): Row[] {
  let sql = 'SELECT * FROM cv_versions WHERE profile_id = ?';
  if (activeOnly) sql += ' AND is_active = 1';
  sql += ' ORDER BY created_at DESC';
  return conn.prepare(sql).all(profileId) as Row[];
}

export function getCv(conn: Conn, cvId: number): Row | null {
  const row = conn.prepare('SELECT * FROM cv_versions WHERE id = ?').get(cvId) as Row | undefined;
  return row ?? null;
}

export function deactivateCv(conn: Conn, cvId: number): void {
  conn.prepare('UPDATE cv_versions SET is_active = 0 WHERE id = ?').run(cvId);
}

// ── jobs ─────────────────────────────────────────────────────────────────────

export interface CreateJobInput {
  profileId: number;
  title: string;
  company: string;
  description: string;
  source?: string;
  language?: string;
}

export function createJob(conn: Conn, input: CreateJobInput): number {
  const ts = now();
  const info = conn
    .prepare(
      `INSERT INTO jobs
       (profile_id, title, company, description, source, language, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      input.profileId,
      input.title,
      input.company,
      input.description,
      input.source ?? '',
      input.language ?? '',
      ts,
      ts,
    );
  return Number(info.lastInsertRowid);
}

export function updateJob(conn: Conn, jobId: number, fields: Row): void {
  const allowed = new Set(['title', 'company', 'description', 'source', 'language', 'status', 'error']);
  const updates: Row = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.has(key)) updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return;
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(', ');
  conn
    .prepare(`UPDATE jobs SET ${assignments} WHERE id = ?`)
    .run(...Object.values(updates), jobId);
}

export function getJob(conn: Conn, jobId: number): Row | null {
  const row = conn.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row | undefined;
  return row ?? null;
}

export function listJobs(conn: Conn, limit = 100): Row[] {
  return conn
    .prepare(
      `SELECT j.*,
              (SELECT COUNT(*) FROM generated_cvs g WHERE g.job_id = j.id) AS generated_count
       FROM jobs j ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
}

// ── analyses ─────────────────────────────────────────────────────────────────

export function saveAnalysis(
  conn: Conn,
  jobId: number,
  cvVersionId: number | null,
  score: number,
  verdict: string,
  payload: unknown,
): number {
  const info = conn
    .prepare(
      `INSERT INTO analyses (job_id, cv_version_id, score, verdict, json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(jobId, cvVersionId, score, verdict, json(payload), now());
  return Number(info.lastInsertRowid);
}

export function latestAnalysis(conn: Conn, jobId: number): Row | null {
  const row = conn
    .prepare('SELECT * FROM analyses WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(jobId) as Row | undefined;
  if (!row) return null;
  const out: Row = { ...row };
  out.data = parseJson(out.json, {});
  delete out.json;
  return out;
}

// ── generated CVs ────────────────────────────────────────────────────────────

export function saveGeneratedCv(
  conn: Conn,
  input: {
    jobId: number;
    analysisId: number | null;
    language: string;
    docxPath: string;
    pdfPath: string;
    content: unknown;
    warnings: string[];
  },
): number {
  const info = conn
    .prepare(
      `INSERT INTO generated_cvs
       (job_id, analysis_id, language, docx_path, pdf_path, content_json, warnings_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.jobId,
      input.analysisId,
      input.language,
      input.docxPath,
      input.pdfPath,
      json(input.content),
      json(input.warnings),
      now(),
    );
  return Number(info.lastInsertRowid);
}

function generatedFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.content = parseJson(item.content_json, {});
  item.warnings = parseJson(item.warnings_json, []);
  delete item.content_json;
  delete item.warnings_json;
  return item;
}

export function listGenerated(conn: Conn, jobId: number): Row[] {
  const rows = conn
    .prepare('SELECT * FROM generated_cvs WHERE job_id = ? ORDER BY created_at DESC, id DESC')
    .all(jobId) as Row[];
  return rows.map(generatedFromRow);
}

export function getGenerated(conn: Conn, generatedId: number): Row | null {
  const row = conn
    .prepare('SELECT * FROM generated_cvs WHERE id = ?')
    .get(generatedId) as Row | undefined;
  return row ? generatedFromRow(row) : null;
}

// ── workflows / agent runs / artifacts ───────────────────────────────────────

export function createWorkflow(
  conn: Conn,
  kind: string,
  title: string,
  inputPayload: unknown = {},
  workspacePath: string | null = null,
): number {
  const info = conn
    .prepare(
      `INSERT INTO workflow_runs (kind, title, status, input_json, workspace_path, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    )
    .run(kind, title, json(inputPayload ?? {}), workspacePath, now());
  return Number(info.lastInsertRowid);
}

export function updateWorkflow(conn: Conn, runId: number, fields: Row): void {
  const allowed = new Set(['status', 'output_json', 'workspace_path', 'error', 'finished_at']);
  const updates: Row = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.has(key)) updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return;
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(', ');
  conn
    .prepare(`UPDATE workflow_runs SET ${assignments} WHERE id = ?`)
    .run(...Object.values(updates), runId);
}

function workflowFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.input = parseJson(item.input_json, {});
  item.output = parseJson(item.output_json, null);
  delete item.input_json;
  delete item.output_json;
  return item;
}

export function getWorkflow(conn: Conn, runId: number): Row | null {
  const row = conn.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Row | undefined;
  return row ? workflowFromRow(row) : null;
}

export function listWorkflows(conn: Conn, limit = 50): Row[] {
  const rows = conn
    .prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Row[];
  return rows.map(workflowFromRow);
}

export function startAgentRun(
  conn: Conn,
  workflowRunId: number | null,
  workflow: string,
  role: string,
  inputPayload: unknown,
  provider: string,
  model: string,
): number {
  const info = conn
    .prepare(
      `INSERT INTO agent_runs
       (workflow_run_id, workflow, role, status, input_json, provider, model, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .run(workflowRunId, workflow, role, json(inputPayload), provider, model, now());
  return Number(info.lastInsertRowid);
}

export function finishAgentRun(
  conn: Conn,
  runId: number,
  status: string,
  output?: unknown,
  error?: string | null,
  promptTokens = 0,
  completionTokens = 0,
): void {
  conn
    .prepare(
      `UPDATE agent_runs
       SET status = ?, output_json = ?, error = ?, prompt_tokens = ?, completion_tokens = ?,
           finished_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      output === undefined ? null : json(output),
      error ?? null,
      promptTokens,
      completionTokens,
      now(),
      runId,
    );
}

function agentRunFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.input = parseJson(item.input_json, {});
  item.output = parseJson(item.output_json, null);
  delete item.input_json;
  delete item.output_json;
  return item;
}

export function listAgentRuns(conn: Conn, workflowRunId: number | null = null, limit = 100): Row[] {
  const rows =
    workflowRunId === null
      ? (conn
          .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit) as Row[])
      : (conn
          .prepare('SELECT * FROM agent_runs WHERE workflow_run_id = ? ORDER BY id ASC LIMIT ?')
          .all(workflowRunId, limit) as Row[]);
  return rows.map(agentRunFromRow);
}

export function saveArtifact(
  conn: Conn,
  workflowRunId: number | null,
  agentRunId: number | null,
  name: string,
  kind: string,
  content: string | null = null,
  artifactPath: string | null = null,
): number {
  const info = conn
    .prepare(
      `INSERT INTO artifacts (workflow_run_id, agent_run_id, name, kind, content, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(workflowRunId, agentRunId, name, kind, content, artifactPath, now());
  return Number(info.lastInsertRowid);
}

export function listArtifacts(conn: Conn, workflowRunId: number): Row[] {
  return conn
    .prepare('SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY id ASC')
    .all(workflowRunId) as Row[];
}

export function stats(conn: Conn): Record<string, number> {
  const count = (table: string): number =>
    Number((conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
  return {
    cv_versions: count('cv_versions'),
    jobs: count('jobs'),
    generated_cvs: count('generated_cvs'),
    workflow_runs: count('workflow_runs'),
    agent_runs: count('agent_runs'),
  };
}
