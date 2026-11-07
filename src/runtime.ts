/**
 * @file Runtime helpers for settings, profiles, and file utilities.
 *
 * Applies persisted settings, resolves the default profile, sanitises filenames,
 * and guesses MIME types for uploads.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Settings } from './config';
import * as db from './db';

/** Apply settings stored in the local database, then lock the database down. */
/** Load persisted settings from the DB into the settings object. */
export function applyStoredSettings(settings: Settings): Settings {
  db.initDb(settings.dbPath);
  const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
  if (Object.keys(stored).length) settings.applyConfig(stored);
  try {
    fs.chmodSync(settings.dbPath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is not meaningful.
  }
  return settings;
}

/** Ensure and return the default profile id. */
export function defaultProfileId(settings: Settings): number {
  return db.withSession(settings.dbPath, (conn) => Number(db.getOrCreateProfile(conn).id));
}

/** Python's Path(name).name and the upload sanitiser used by the web app. */
/** Sanitise a filename for storage (Python-compatible). */
export function safeFilename(name: string): string {
  const base = path.basename(name || 'upload');
  const cleaned = [...base]
    .map((char) => (/[\p{L}\p{N}._\- ]/u.test(char) ? char : '_'))
    .join('')
    .trim();
  return cleaned.slice(0, 120) || 'upload';
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

/** A small replacement for mimetypes.guess_type for supported uploads. */
/** Guess a MIME type from a filename extension. */
export function mimeFor(name: string): string {
  return MIME_TYPES[path.extname(name || '').toLowerCase()] ?? 'application/octet-stream';
}

/** Type guard for provider names accepted by the web form. */
export function isProviderName(value: string): boolean {
  return ['openai', 'anthropic', 'ollama', 'opencode', 'mock'].includes(value);
}
