import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Settings, defaultBaseUrlFor, defaultModelFor } from './config';
import * as db from './db';
import { HEADHUNTER, OFFICE_MANAGER, RESUME_WRITER } from './agents/prompts';
import { extractText } from './documents/extract';
import { buildLlm } from './llm';
import { MockClient } from './llm/mock';
import { FirmService } from './orchestrator/firm';
import { applyStoredSettings, defaultProfileId, mimeFor, safeFilename } from './runtime';

interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value: string | boolean = true;
      const equals = key.indexOf('=');
      if (equals !== -1) {
        value = key.slice(equals + 1);
        key = key.slice(0, equals);
      } else if (index + 1 < args.length && !args[index + 1].startsWith('--')) {
        value = args[index + 1];
        index += 1;
      }
      options[key] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

function optionString(options: Record<string, string | boolean>, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : '';
}

function optionBool(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] !== undefined && options[key] !== false && options[key] !== 'false';
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

async function readDescription(options: Record<string, string | boolean>): Promise<string> {
  const text = optionString(options, 'text');
  if (text) return text;
  if (optionBool(options, 'stdin')) return readStdin();
  const file = optionString(options, 'file');
  if (file) {
    if (file === '-') return readStdin();
    return extractText(file);
  }
  throw new Error('Provide a job description with --text, --file, or --stdin.');
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

async function cmdInit(settings: Settings): Promise<number> {
  settings.ensureDirs();
  db.initDb(settings.dbPath);
  const profileId = defaultProfileId(settings);
  console.log(`Initialised Career Firm in ${settings.dataDir}`);
  console.log(`  database: ${settings.dbPath}`);
  console.log(`  profile id: ${profileId}`);
  console.log(`  provider: ${settings.provider} / ${settings.model}`);
  console.log(
    'Next: career-firm profile set-context <file> and profile add-cv <file> --vertical <name>',
  );
  return 0;
}

function cmdConfig(settings: Settings): number {
  console.log(JSON.stringify(settings.publicDict(), null, 2));
  return 0;
}

function cmdDoctor(settings: Settings): number {
  db.initDb(settings.dbPath);
  const llm = buildLlm(settings);
  console.log('Career Firm doctor');
  console.log(`  node: ${process.version.replace(/^v/, '')}`);
  console.log(`  data: ${settings.dataDir}`);
  console.log(`  database: ${settings.dbPath}`);
  console.log(`  provider: ${settings.provider}`);
  console.log(`  model: ${settings.model}`);
  if (llm instanceof MockClient && llm.reason) {
    console.log(
      `  WARNING: running offline (${llm.reason}). ` +
        'Open Settings in the web app to choose a provider.',
    );
  } else {
    console.log(`  client: ${llm.constructor.name}`);
  }
  for (const moduleName of [
    'express',
    'better-sqlite3',
    'ejs',
    'docx',
    'pdf-parse',
    'pdfkit',
    'zod',
    'mammoth',
  ]) {
    try {
      require.resolve(moduleName);
      console.log(`  dependency ${moduleName}: ok`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  dependency ${moduleName}: MISSING (${message})`);
    }
  }
  const font = settings.fontPath || '/System/Library/Fonts/Supplemental/Arial.ttf';
  const fontFound = fs.existsSync(font) && fs.statSync(font).isFile();
  console.log(`  pdf font: ${font} (${fontFound ? 'found' : 'not found'})`);
  const stats = db.withSession(settings.dbPath, (conn) => db.stats(conn));
  console.log(`  stats: ${JSON.stringify(stats)}`);
  return 0;
}

async function cmdProfile(
  settings: Settings,
  positionals: string[],
  options: Record<string, string | boolean>,
): Promise<number> {
  db.initDb(settings.dbPath);
  const profileId = defaultProfileId(settings);
  const subcommand = positionals[0];

  if (subcommand === 'show') {
    const data = db.withSession(settings.dbPath, (conn) => ({
      profile: db.getProfile(conn, profileId),
      cvs: db.listCvs(conn, profileId, false),
    }));
    const profile = data.profile;
    console.log(`profile #${profileId}`);
    console.log(
      `context: ${profile?.context_text?.length ?? 0} chars (${
        profile?.context_filename || 'none'
      })`,
    );
    console.log(`cvs: ${data.cvs.length}`);
    for (const cv of data.cvs) {
      const state = cv.is_active ? 'active' : 'inactive';
      console.log(`  #${cv.id} [${cv.vertical}] ${cv.filename} (${state})`);
    }
    return 0;
  }

  if (subcommand === 'set-context') {
    const file = positionals[1];
    if (!file) throw new Error('Provide a context file.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`File not found: ${file}`);
    }
    const raw = await extractText(file);
    const destDir = path.join(settings.storageDir, 'context');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(
      destDir,
      `${crypto.randomBytes(4).toString('hex')}_${safeFilename(path.basename(file))}`,
    );
    fs.copyFileSync(file, dest);
    new FirmService(settings).setContext({
      profileId,
      text: raw,
      filename: path.basename(file),
    });
    console.log(`Context saved (${raw.length} chars) from ${path.basename(file)}`);
    return 0;
  }

  if (subcommand === 'add-cv') {
    const file = positionals[1];
    if (!file) throw new Error('Provide a CV file.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`File not found: ${file}`);
    }
    const raw = await extractText(file);
    const destDir = path.join(settings.storageDir, 'cvs', `profile_${profileId}`);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(
      destDir,
      `${crypto.randomBytes(4).toString('hex')}_${safeFilename(path.basename(file))}`,
    );
    fs.copyFileSync(file, dest);
    const vertical = optionString(options, 'vertical') || path.parse(file).name;
    const result = await new FirmService(settings).importCv({
      profileId,
      vertical,
      filename: path.basename(file),
      filePath: dest,
      mime: mimeFor(file),
      rawText: raw,
    });
    const parsed = result.parsed;
    console.log(`Imported CV #${result.id} [${vertical}] ${path.basename(file)}`);
    console.log(
      `  parsed: ${parsed.experience.length} roles, ${parsed.skills.length} skills, ` +
        `${parsed.education.length} education entries`,
    );
    return 0;
  }

  if (subcommand === 'list-cvs') {
    const cvs = db.withSession(settings.dbPath, (conn) => db.listCvs(conn, profileId));
    for (const cv of cvs) {
      console.log(`#${cv.id} [${cv.vertical}] ${cv.filename} (${cv.raw_text.length} chars)`);
    }
    return 0;
  }

  throw new Error('Unknown profile command');
}

async function runJob(settings: Settings, jobId: number): Promise<number> {
  console.log(`Running tailoring for job #${jobId}...`);
  let result;
  try {
    result = await new FirmService(settings).tailor(jobId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`FAILED: ${err.name}: ${err.message}`);
    return 1;
  }
  console.log(`Done. Match score: ${result.score}/100`);
  console.log(`  PDF:  ${result.pdf_path}`);
  console.log(`  DOCX: ${result.docx_path}`);
  if (result.warnings.length) {
    console.log(`  grounding warnings: ${result.warnings.length}`);
    for (const warning of result.warnings.slice(0, 10)) console.log(`    - ${warning}`);
  }
  return 0;
}

async function cmdJob(
  settings: Settings,
  positionals: string[],
  options: Record<string, string | boolean>,
): Promise<number> {
  db.initDb(settings.dbPath);
  const profileId = defaultProfileId(settings);
  const subcommand = positionals[0];

  if (subcommand === 'add') {
    const description = await readDescription(options);
    if (!description.trim()) throw new Error('The job description is empty.');
    const source = optionString(options, 'file') || (optionBool(options, 'stdin') ? 'stdin' : 'text');
    const jobId = db.withSession(settings.dbPath, (conn) =>
      db.createJob(conn, {
        profileId,
        title: optionString(options, 'title'),
        company: optionString(options, 'company'),
        description,
        source,
        language: optionString(options, 'language'),
      }),
    );
    console.log(`Created job #${jobId}`);
    if (optionBool(options, 'no-run')) return 0;
    return runJob(settings, jobId);
  }

  if (subcommand === 'run') {
    const jobId = Number.parseInt(positionals[1] ?? '', 10);
    if (!Number.isFinite(jobId)) throw new Error('Provide a numeric job id.');
    return runJob(settings, jobId);
  }

  if (subcommand === 'list') {
    const jobs = db.withSession(settings.dbPath, (conn) => db.listJobs(conn));
    for (const job of jobs) {
      console.log(
        `#${padLeft(String(job.id), 3)} ${padRight(job.status, 10)} ` +
          `${padRight(job.title || '(untitled)', 38)} ` +
          `${padRight(job.company || '', 24)} generated=${job.generated_count}`,
      );
    }
    return 0;
  }

  if (subcommand === 'show') {
    const jobId = Number.parseInt(positionals[1] ?? '', 10);
    if (!Number.isFinite(jobId)) throw new Error('Provide a numeric job id.');
    const data = db.withSession(settings.dbPath, (conn) => {
      const job = db.getJob(conn, jobId);
      if (!job) return null;
      return {
        job,
        analysis: db.latestAnalysis(conn, jobId),
        generated: db.listGenerated(conn, jobId),
      };
    });
    if (!data) throw new Error(`Job ${jobId} not found`);
    if (optionBool(options, 'json')) {
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    const { job, analysis, generated } = data;
    console.log(`Job #${job.id}: ${job.title} @ ${job.company}`);
    console.log(`  status: ${job.status}`);
    if (job.error) console.log(`  error: ${job.error}`);
    if (analysis) {
      console.log(`  match: ${analysis.verdict}`);
      const analysisData = analysis.data || {};
      for (const item of (analysisData.strengths || []).slice(0, 5)) {
        console.log(`    + ${String(item.requirement || '').slice(0, 100)}`);
      }
      for (const item of (analysisData.gaps || []).slice(0, 5)) {
        console.log(`    - ${String(item.requirement || '').slice(0, 100)}`);
      }
    }
    for (const generatedCv of generated) {
      console.log(`  generated #${generatedCv.id}: ${generatedCv.pdf_path}`);
      console.log(`                     ${generatedCv.docx_path}`);
      if (generatedCv.warnings?.length) {
        console.log(`    warnings: ${generatedCv.warnings.length}`);
      }
    }
    return 0;
  }

  throw new Error('Unknown job command');
}

async function cmdServe(
  settings: Settings,
  options: Record<string, string | boolean>,
): Promise<number> {
  const { startServer } = await import('./server');
  const host = optionString(options, 'host') || settings.host;
  const port = Number.parseInt(optionString(options, 'port'), 10) || settings.port;
  startServer({ settings, host, port });
  return 0;
}

function cmdAgents(options: Record<string, string | boolean>): number {
  const roles: Record<string, [string, string]> = {
    office_manager: ['Office Manager', OFFICE_MANAGER],
    headhunter: ['Headhunter', HEADHUNTER],
    resume_writer: ['Resume Writer', RESUME_WRITER],
  };
  const selected = optionString(options, 'prompt');
  if (selected) {
    if (!(selected in roles)) {
      throw new Error(`Unknown role. Choose: ${Object.keys(roles).join(', ')}`);
    }
    console.log(roles[selected][1]);
    return 0;
  }
  for (const [key, [label, prompt]] of Object.entries(roles)) {
    const firstLine = (prompt.trim().split('\n')[0] ?? '').slice(0, 100);
    console.log(`${padRight(key, 18)} ${padRight(label, 18)} ${firstLine}`);
  }
  return 0;
}

export const HELP = `usage: career-firm [--home HOME] <command> ...

Agent-run career firm: import CVs, analyse jobs, generate ATS-ready tailored CVs.

commands:
  init                 Initialise the local database and data directories
  config               Print the effective configuration
  doctor               Check dependencies, provider, database, and fonts
  profile show         Show the profile and CV inventory
  profile set-context  Import the context file
  profile add-cv       Import a CV version (--vertical NAME)
  profile list-cvs     List CV versions
  job add              Create a job and run tailoring (--text/--file/--stdin)
  job run ID           Run or re-run tailoring for a job
  job list             List jobs
  job show ID          Show a job, analysis, and generated files (--json)
  serve                Run the local web app (--host/--port)
  agents               List agent roles or print a role prompt (--prompt ROLE)
`;

export async function main(argv: string[]): Promise<number> {
  const global = parseArguments(argv);
  let positionals = global.positionals;
  const home = optionString(global.options, 'home');
  if (home) process.env.CAREER_FIRM_HOME = home;

  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    return 0;
  }

  const settings = applyStoredSettings(Settings.load());

  try {
    if (command === 'init') return await cmdInit(settings);
    if (command === 'config') return cmdConfig(settings);
    if (command === 'doctor') return cmdDoctor(settings);
    if (command === 'profile') {
      return await cmdProfile(settings, positionals.slice(1), global.options);
    }
    if (command === 'job') {
      return await cmdJob(settings, positionals.slice(1), global.options);
    }
    if (command === 'agents') return cmdAgents(global.options);
    if (command === 'serve') return await cmdServe(settings, global.options);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Error: ${err.message}`);
    return 1;
  }

  process.stdout.write(HELP);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}
