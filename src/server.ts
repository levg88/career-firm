import express from 'express';
import http from 'node:http';

import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';

import { Settings } from './config';
import { applyStoredSettings } from './runtime';
import { createApp } from './api/app';
import * as db from './db';
import { LinkedInService } from './services/linkedin';
import { postGeneration } from './services/postGeneration';
import { buildLlm } from './llm';

// Minimal app used by the LinkedIn posts mini-app tests.
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/auth', authRoutes);
app.use('/posts', postsRoutes);

export interface StartServerOptions {
  settings?: Settings;
  host?: string;
  port?: number;
}

export function startServer(options: StartServerOptions = {}): http.Server {
  const settings = options.settings ?? applyStoredSettings(Settings.load());
  const firmApp = createApp(settings);
  const host = options.host || settings.host;
  const port = options.port || settings.port;
  const server = firmApp.listen(port, host, () => {
    console.log(`Career Firm on http://${host}:${port}`);
  });

  let lastScheduledDate = '';
  const tick = async () => {
    try {
      const s = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
      if (s.linkedin_schedule_enabled !== 'true') return;
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const currentTime = `${hh}:${mm}`;
      if (currentTime !== (s.linkedin_schedule_time || '09:00')) return;
      const today = now.toISOString().slice(0, 10);
      if (lastScheduledDate === today) return;
      lastScheduledDate = today;
      const theme = s.linkedin_schedule_theme || 'Daily Update';
      const profile = db.withSession(settings.dbPath, (conn) => db.getOrCreateProfile(conn));
      const post = await postGeneration.generateAsync(
        theme,
        buildLlm(settings),
        String(profile.context_text || ''),
      );
      db.withSession(settings.dbPath, (conn) =>
        db.saveAppSettings(conn, { linkedin_last_post: JSON.stringify(post) }),
      );
      if (s.linkedin_auto_publish === 'true' && s.linkedin_access_token) {
        const svc = new LinkedInService({ accessToken: s.linkedin_access_token });
        await svc.publishPost(post.text, post.image?.url);
        const updated = { ...post, published: true, publishedAt: new Date().toISOString() };
        db.withSession(settings.dbPath, (conn) =>
          db.saveAppSettings(conn, { linkedin_last_post: JSON.stringify(updated) }),
        );
      }
    } catch {
      // Ignore scheduler errors.
    }
  };
  setInterval(tick, 60 * 1000);

  return server;
}

if (require.main === module) {
  startServer();
}

export default app;
