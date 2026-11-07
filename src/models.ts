/**
 * @file Zod schemas and inferred TypeScript types for firm data.
 *
 * Defines and exports the schemas for contact info, experience, education,
 * parsed CVs, job analyses, tailored CVs, plus coercion helpers for LLM output.
 */

import { z } from 'zod';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** LLMs occasionally return a string, dict of lists, or list of objects. */
/** Coerce LLM output (string/dict/list) into a string array. */
export function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (isRecord(value)) {
    const out: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item)) {
        out.push(...item.filter((x) => String(x).trim()).map((x) => `${key}: ${x}`));
      } else if (String(item).trim()) {
        out.push(`${key}: ${item}`);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (isRecord(item)) {
        out.push(String(item.text || item.name || item.requirement || JSON.stringify(item)));
      } else if (String(item).trim()) {
        out.push(String(item).trim());
      }
    }
    return out;
  }
  return [String(value)];
}

/** Coerce any value into a trimmed string. */
export function coerceText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function coerceScore(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const raw = typeof value === 'string' ? value.trim().replace(/%$/, '') : value;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(parsed)));
}

function coerceOptionalInt(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    value === 'null' ||
    value === 'None' ||
    value === 0 ||
    value === '0'
  ) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asEvidenceList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  let items: unknown[] = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      if (typeof item === 'string') return { requirement: item };
      return item;
    })
    .filter((item) => isRecord(item));
}

const textField = z.preprocess((value) => coerceText(value), z.string());
const listField = z.preprocess((value) => asList(value), z.array(z.string()));

export const contactInfoSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z.object({
    email: textField,
    phone: textField,
    location: textField,
    linkedin: textField,
    website: textField,
  }),
);

function experiencePreprocess(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const data: UnknownRecord = { ...value };
  if (!data.start && data.dates) {
    const dates = String(data.dates);
    if (dates.includes('–') || dates.includes(' - ')) {
      const separator = dates.includes('–') ? '–' : ' - ';
      const [start, ...rest] = dates.split(separator);
      if (data.start === undefined) data.start = (start ?? '').trim();
      if (data.end === undefined) data.end = rest.join(separator).trim();
    }
  }
  if (data.bullets === undefined || data.bullets === null) {
    data.bullets = data.achievements || data.highlights;
  }
  return data;
}

export const experienceItemSchema = z.preprocess(
  experiencePreprocess,
  z.object({
    company: textField,
    title: textField,
    location: textField,
    start: textField,
    end: textField,
    context: textField,
    bullets: listField,
  }),
);

export const educationItemSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z.object({
    institution: textField,
    degree: textField,
    location: textField,
    year: textField,
    details: textField,
  }),
);

function parsedCvPreprocess(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const data: UnknownRecord = { ...value };
  if (!('experience' in data)) {
    data.experience = data.work_experience || data.positions;
  }
  if (!('education' in data)) {
    data.education = data.education_history;
  }
  if (!('summary' in data)) {
    data.summary = data.professional_summary || data.profile;
  }
  return data;
}

export const parsedCvSchema = z.preprocess(
  parsedCvPreprocess,
  z.object({
    name: textField,
    headline: textField,
    contact: contactInfoSchema,
    summary: textField,
    experience: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(experienceItemSchema),
    ),
    education: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(educationItemSchema),
    ),
    skills: listField,
    certifications: listField,
    languages: listField,
    achievements: listField,
  }),
);

export const evidenceSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z.object({
    requirement: textField,
    evidence: textField,
    source: textField,
  }),
);

export const gapSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z.object({
    requirement: textField,
    severity: textField,
    mitigation: textField,
  }),
);

function jobAnalysisPreprocess(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const data: UnknownRecord = { ...value };
  const aliases: Record<string, string> = {
    must_haves: 'must_have',
    nice_to_haves: 'nice_to_have',
    keywords: 'ats_keywords',
    score: 'match_score',
    match: 'match_score',
    recommended_cv: 'recommended_cv_id',
    vertical: 'recommended_vertical',
  };
  for (const [old, target] of Object.entries(aliases)) {
    if (!(target in data) && old in data) data[target] = data[old];
  }
  if (Array.isArray(data.strengths)) {
    data.strengths = data.strengths.map((x) => (typeof x === 'string' ? { requirement: x } : x));
  }
  if (Array.isArray(data.gaps)) {
    data.gaps = data.gaps.map((x) => (typeof x === 'string' ? { requirement: x } : x));
  }
  return data;
}

export const jobAnalysisSchema = z.preprocess(
  jobAnalysisPreprocess,
  z.object({
    job_title: textField,
    company: textField,
    location: textField,
    seniority: textField,
    language: z.preprocess((value) => coerceText(value) || 'en', z.string()),
    summary: textField,
    must_have: listField,
    nice_to_have: listField,
    responsibilities: listField,
    ats_keywords: listField,
    culture_signals: listField,
    red_flags: listField,
    match_score: z.preprocess(coerceScore, z.number().int().min(0).max(100)),
    match_level: textField,
    strengths: z.preprocess(asEvidenceList, z.array(evidenceSchema)),
    gaps: z.preprocess(asEvidenceList, z.array(gapSchema)),
    recommended_cv_id: z.preprocess(coerceOptionalInt, z.number().int().nullable()),
    recommended_vertical: textField,
    tailoring_plan: listField,
    keywords_to_include: listField,
    do_not_claim: listField,
    analyzer_notes: textField,
  }),
);

function tailoredCvPreprocess(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const data: UnknownRecord = { ...value };
  if (!data.summary) data.summary = data.professional_summary;
  if (!data.core_competencies) data.core_competencies = data.competencies;
  if (!data.ats_keywords) data.ats_keywords = data.keywords;
  if (!data.contact) {
    data.contact = {
      email: data.email ?? '',
      phone: data.phone ?? '',
      location: data.location ?? '',
      linkedin: data.linkedin ?? '',
      website: data.website ?? '',
    };
  }
  return data;
}

export const tailoredCvSchema = z.preprocess(
  tailoredCvPreprocess,
  z.object({
    language: z.preprocess((value) => coerceText(value) || 'en', z.string()),
    name: textField,
    headline: textField,
    contact: contactInfoSchema,
    summary: textField,
    core_competencies: listField,
    experience: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(experienceItemSchema),
    ),
    education: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(educationItemSchema),
    ),
    certifications: listField,
    skills: listField,
    languages: listField,
    ats_keywords: listField,
    change_log: listField,
    grounding: z.preprocess(
      (value) => (Array.isArray(value) ? value.filter((x) => isRecord(x)) : []),
      z.array(evidenceSchema),
    ),
  }),
);

export type ContactInfo = z.infer<typeof contactInfoSchema>;
export type ExperienceItem = z.infer<typeof experienceItemSchema>;
export type EducationItem = z.infer<typeof educationItemSchema>;
export type ParsedCV = z.infer<typeof parsedCvSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Gap = z.infer<typeof gapSchema>;
export type JobAnalysis = z.infer<typeof jobAnalysisSchema>;
export type TailoredCV = z.infer<typeof tailoredCvSchema>;
