import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Settings } from '../src/config';
import * as db from '../src/db';

export const SAMPLE_CV = `Jane Doe
VP Engineering | AI Platforms
jane.doe@example.com | +1 415 555 0123 | linkedin.com/in/janedoe

SUMMARY
Engineering executive with 15 years building AI and data platforms.

EXPERIENCE
Acme Corp | VP Engineering | San Francisco | 2020 - Present
• Led a team of 45 engineers and grew platform revenue 32%.
• Launched an LLM platform used by 120 enterprise customers.
• Cut cloud spend by $2.4M annually.

Beta Systems | Director of Engineering | 2015 - 2020
• Built a data platform processing 5 billion events per day.
• Scaled the team from 8 to 30 engineers.

EDUCATION
Stanford University | MS Computer Science | 2008

SKILLS
AI, LLM, Platform Engineering, Cloud, Kubernetes, Python

CERTIFICATIONS
AWS Solutions Architect
`;

export const SAMPLE_JD = `VP Engineering, AI Platform
Company: Nimbus AI

We are hiring a VP Engineering to lead our AI platform.

Must have 10+ years of engineering leadership and experience scaling teams.
Must have experience with LLM platforms and enterprise customers.
Nice to have cloud cost optimization.

Responsibilities:
- Lead the engineering organisation.
- Build the platform roadmap and drive revenue.
`;

const MANAGED_ENV = [
  'CAREER_FIRM_HOME',
  'CAREER_FIRM_PROVIDER',
  'CAREER_FIRM_MODEL',
  'CAREER_FIRM_HEURISTIC_FALLBACK',
  'CAREER_FIRM_SETUP_COMPLETE',
  'CAREER_FIRM_AGENTS_DIR',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
];

type EnvSnapshot = Map<string, string | undefined>;

export function snapshotEnv(): EnvSnapshot {
  return new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export interface SettingsOptions {
  home?: string;
  provider?: string;
  setupComplete?: boolean;
}

export function makeSettings(options: SettingsOptions = {}): Settings {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-'));
  const snapshot = snapshotEnv();
  process.env.CAREER_FIRM_HOME = home;
  process.env.CAREER_FIRM_PROVIDER = options.provider ?? 'mock';
  process.env.CAREER_FIRM_MODEL = options.provider ?? 'mock';
  process.env.CAREER_FIRM_HEURISTIC_FALLBACK = 'true';
  process.env.CAREER_FIRM_SETUP_COMPLETE = options.setupComplete === false ? 'false' : 'true';
  delete process.env.CAREER_FIRM_AGENTS_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENCODE_API_KEY;

  const settings = Settings.load();
  restoreEnv(snapshot);
  settings.ensureDirs();
  db.initDb(settings.dbPath);
  return settings;
}

export function makeFreshSettings(): Settings {
  return makeSettings({ setupComplete: false });
}

export function profileId(settings: Settings): number {
  return db.withSession(settings.dbPath, (conn) => Number(db.getOrCreateProfile(conn).id));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
