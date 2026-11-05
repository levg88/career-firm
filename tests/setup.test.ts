import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app';
import { Settings, defaultBaseUrlFor, defaultModelFor } from '../src/config';
import * as db from '../src/db';
import { buildLlm, OpenAICompatClient } from '../src/llm';
import { applyStoredSettings } from '../src/runtime';
import {
  makeFreshSettings,
  makeSettings,
  restoreEnv,
  SAMPLE_CV,
  snapshotEnv,
} from './helpers';

describe('first-run setup', () => {
  it('redirects every app page to the wizard', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));

    const response = await agent.get('/');
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/setup');

    const profile = await agent.get('/profile');
    expect(profile.status).toBe(303);
    expect(profile.headers.location).toBe('/setup');

    const health = await agent.get('/health');
    expect(health.body.ok).toBe(true);
    expect(health.body.setup_complete).toBe(false);
  });

  it('renders the setup wizard fields', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent.get('/setup');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Set up Career Firm');
    expect(response.text).toContain('name="provider"');
    expect(response.text).toContain('name="api_key"');
    expect(response.text).toContain('name="context_file"');
    expect(response.text).toContain('name="cv_file"');
  });

  it('saves config and imports source material', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));

    const response = await agent
      .post('/setup')
      .field('provider', 'mock')
      .field('model', 'mock')
      .field('default_language', 'en')
      .field('context_text', 'Executive engineering leader focused on AI platforms.')
      .field('vertical', 'AI Platforms')
      .attach('cv_file', Buffer.from(SAMPLE_CV), {
        filename: 'jane.md',
        contentType: 'text/markdown',
      });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/?welcome=1');
    expect(settings.setupComplete).toBe(true);
    expect(settings.provider).toBe('mock');

    const snapshot = db.withSession(settings.dbPath, (conn) => {
      const profile = db.getOrCreateProfile(conn);
      return {
        stored: db.getAppSettings(conn),
        profile,
        cvs: db.listCvs(conn, Number(profile.id), false),
      };
    });
    expect(snapshot.stored.provider).toBe('mock');
    expect(snapshot.stored.setup_complete).toBe('true');
    expect(snapshot.profile.context_text).toContain('Executive engineering leader');
    expect(snapshot.cvs.map((cv) => cv.vertical)).toEqual(['AI Platforms']);

    const dashboard = await agent.get('/?welcome=1');
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain('Setup complete');
  });

  it('requires a key for hosted providers', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent
      .post('/setup')
      .field('provider', 'openai')
      .field('model', 'gpt-4.1');
    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenAI API key is required');
  });

  it('masks the stored key and keeps it when left blank', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const secret = 'sk-test-1234567890';

    const saved = await agent
      .post('/setup')
      .field('provider', 'openai')
      .field('model', 'gpt-4.1')
      .field('base_url', 'https://api.openai.com/v1')
      .field('api_key', secret);
    expect(saved.status).toBe(303);

    const page = await agent.get('/settings');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(secret);
    expect(page.text).toContain('sk-…7890');

    const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
    expect(stored.api_key).toBe(secret);
    expect(stored.setup_complete).toBe('true');

    const kept = await agent
      .post('/settings')
      .field('provider', 'openai')
      .field('model', 'gpt-4.1')
      .field('base_url', 'https://api.openai.com/v1')
      .field('api_key', '');
    expect(kept.status).toBe(303);
    expect(db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn)).api_key).toBe(
      secret,
    );
  });
});

describe('OpenCode provider', () => {
  it('saves the OpenCode provider and key', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const secret = 'oc_test_key_1234567890';

    const response = await agent
      .post('/setup')
      .field('provider', 'opencode')
      .field('model', 'deepseek-v4.1-flash-free')
      .field('base_url', 'https://opencode.ai/inference/openai/v1')
      .field('api_key', secret);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/?welcome=1');
    expect(settings.provider).toBe('opencode');
    expect(settings.model).toBe('deepseek-v4.1-flash-free');
    expect(settings.opencodeApiKey).toBe(secret);
    expect(settings.opencodeBaseUrl).toBe('https://opencode.ai/inference/openai/v1');

    const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
    expect(stored.provider).toBe('opencode');
    expect(stored.opencode_api_key).toBe(secret);
    expect(stored.opencode_base_url).toBe('https://opencode.ai/inference/openai/v1');
  });

  it('requires an OpenCode key', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent
      .post('/setup')
      .field('provider', 'opencode')
      .field('model', 'deepseek-v4.1-flash-free');
    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenCode API key is required');
  });

  it('builds an OpenCode-compatible client', () => {
    const settings = makeFreshSettings();
    settings.provider = 'opencode';
    settings.opencodeApiKey = 'oc_test_key_1234567890';
    settings.opencodeBaseUrl = 'https://opencode.ai/inference/openai/v1';
    settings.model = 'deepseek-v4.1-flash-free';

    const llm = buildLlm(settings);
    expect(llm).toBeInstanceOf(OpenAICompatClient);
    expect(llm.provider).toBe('opencode');
    expect(llm.model).toBe('deepseek-v4.1-flash-free');
    expect((llm as OpenAICompatClient).apiKey).toBe('oc_test_key_1234567890');
    expect((llm as OpenAICompatClient).baseUrl).toBe(
      'https://opencode.ai/inference/openai/v1',
    );
  });

  it('uses OpenCode defaults and env detection', () => {
    expect(defaultModelFor('opencode')).toBe('deepseek-v4.1-flash-free');
    expect(defaultBaseUrlFor('opencode')).toBe(
      'https://opencode.ai/inference/openai/v1',
    );

    const snapshot = snapshotEnv();
    try {
      process.env.CAREER_FIRM_HOME = makeSettings().home;
      delete process.env.CAREER_FIRM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENCODE_API_KEY = 'oc_test_key_1234567890';
      const detected = Settings.load();
      expect(detected.provider).toBe('opencode');
      expect(detected.opencodeApiKey).toBe('oc_test_key_1234567890');
    } finally {
      restoreEnv(snapshot);
    }
  });
});

describe('stored settings', () => {
  it('are applied by the CLI runtime', () => {
    const settings = makeSettings();
    db.withSession(settings.dbPath, (conn) =>
      db.saveAppSettings(conn, {
        provider: 'ollama',
        model: 'llama3.1',
        setup_complete: 'true',
      }),
    );

    const snapshot = snapshotEnv();
    try {
      process.env.CAREER_FIRM_HOME = settings.home;
      delete process.env.CAREER_FIRM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      const loaded = applyStoredSettings(Settings.load());
      expect(loaded.provider).toBe('ollama');
      expect(loaded.model).toBe('llama3.1');
      expect(loaded.setupComplete).toBe(true);
    } finally {
      restoreEnv(snapshot);
    }
  });
});
