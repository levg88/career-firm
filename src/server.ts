import express from 'express';
import http from 'node:http';

import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';

import { Settings } from './config';
import { applyStoredSettings } from './runtime';
import { createApp } from './api/app';

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
  return server;
}

export default app;
