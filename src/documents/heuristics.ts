import {
  type ContactInfo,
  type EducationItem,
  type Evidence,
  type ExperienceItem,
  type Gap,
  type JobAnalysis,
  type ParsedCV,
  type TailoredCV,
} from '../models';
import { cleanText } from './extract';

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[\w\-/?=&%.]+/i;
const YEAR_RANGE_SOURCE =
  '((?:19|20)\\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s*(?:19|20)\\d{2})' +
  '\\s*[-–—]\\s*' +
  '((?:19|20)\\d{2}|present|current|now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s*(?:19|20)\\d{2})';
const YEAR_RANGE_RE = new RegExp(YEAR_RANGE_SOURCE, 'i');
const YEAR_RANGE_GLOBAL_RE = new RegExp(YEAR_RANGE_SOURCE, 'gi');

const TITLE_WORDS = new Set([
  'director', 'vp', 'vice', 'president', 'chief', 'head', 'manager', 'lead',
  'leader', 'engineer', 'engineering', 'architect', 'scientist', 'analyst',
  'consultant', 'officer', 'founder', 'partner', 'principal', 'staff',
  'senior', 'junior', 'associate', 'specialist', 'coordinator', 'developer',
  'designer', 'strategist', 'advisor', 'counsel', 'controller', 'accountant',
  'supervisor', 'superintendent', 'administrator', 'producer', 'editor',
]);

const COMPANY_WORDS = new Set([
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'group', 'systems',
  'technologies', 'technology', 'solutions', 'labs', 'partners', 'university',
  'bank', 'foundation', 'agency', 'consulting', 'ventures', 'capital',
  'holdings', 'industries', 'services', 'associates', 'institute', 'media',
  'networks', 'software', 'health', 'global', 'international',
]);

const SECTION_MAP: Record<string, string> = {
  summary: 'summary',
  profile: 'summary',
  'professional summary': 'summary',
  'executive summary': 'summary',
  objective: 'summary',
  about: 'summary',
  'about me': 'summary',
  experience: 'experience',
  'professional experience': 'experience',
  'work experience': 'experience',
  employment: 'experience',
  'employment history': 'experience',
  'work history': 'experience',
  'career history': 'experience',
  education: 'education',
  'academic background': 'education',
  skills: 'skills',
  'core competencies': 'skills',
  competencies: 'skills',
  expertise: 'skills',
  'areas of expertise': 'skills',
  'technical skills': 'skills',
  certifications: 'certifications',
  certificates: 'certifications',
  licenses: 'certifications',
  'licenses & certifications': 'certifications',
  languages: 'languages',
  achievements: 'achievements',
  awards: 'achievements',
  'selected achievements': 'achievements',
  projects: 'projects',
  publications: 'projects',
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'that', 'this',
  'from', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'any', 'who', 'how',
  'what', 'when', 'where', 'why', 'into', 'over', 'under', 'about', 'across',
  'through', 'within', 'without', 'their', 'they', 'them', 'its', "it's", 'as',
  'at', 'by', 'be', 'is', 'of', 'on', 'or', 'to', 'in', 'a', 'an', 'we', 'us',
  'role', 'job', 'work', 'team', 'teams', 'company', 'position', 'candidate',
  'experience', 'years', 'year', 'strong', 'ability', 'skills', 'including',
  'required', 'requirements', 'preferred', 'plus', 'must', 'should', 'would',
  'will', 'well', 'more', 'most', 'other', 'such', 'using', 'use', 'new',
  'including', 'include', 'includes', 'ensure', 'ensuring', 'support', 'help',
  'develop', 'developing', 'manage', 'managing', 'build', 'building', 'lead',
  'leading', 'drive', 'driving', 'create', 'creating', 'deliver', 'delivering',
  'nice', 'hiring', 'hire', 'responsibilities', 'responsibility', 'qualifications',
  'preferred', 'benefits', 'salary', 'apply', 'applicants', 'opportunity',
  'looking', 'seeking',
]);

// Words that should not end a keyword phrase harvested from a posting.
const PHRASE_TAIL_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'with', 'in', 'on', 'at',
  'by', 'as', 'from', 'into', 'over', 'under', 'company', 'companies',
]);

const SYNONYMS: Record<string, string> = {
  leadership: 'lead', leading: 'lead', leads: 'lead', leader: 'lead',
  scaling: 'scale', scaled: 'scale', scales: 'scale',
  engineering: 'engineer', engineers: 'engineer',
  customers: 'customer', platforms: 'platform', teams: 'team',
  technologies: 'technology', solutions: 'solution',
  strategies: 'strategy', operations: 'operation',
  organizations: 'organization', management: 'manage',
  managing: 'manage', managed: 'manage',
  development: 'develop', developing: 'develop', developed: 'develop',
  building: 'build', built: 'build', delivering: 'deliver',
  delivered: 'deliver', driving: 'drive', driven: 'drive',
};

/** Python's round() uses banker's rounding; scores must match the Python build. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

function stripChars(value: string, chars: string): string {
  // Python's str.strip treats every character literally. Inside a JS character
  // class, an unescaped '-' creates a range (e.g. ' |,-–—' would swallow
  // letters and digits), so escape every regex metacharacter.
  const escaped = chars.replace(/[\\\]^$.*+?()[{}|/-]/g, '\\$&');
  return value.replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g'), '');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function sectionName(line: string): string | null {
  let cleaned = line.replace(/[^a-zA-Z& ]/g, '').trim().toLowerCase();
  cleaned = collapseWhitespace(cleaned);
  return SECTION_MAP[cleaned] ?? null;
}

function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  sections.set('header', []);
  let current = 'header';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (!sections.has(current)) sections.set(current, []);
      sections.get(current)!.push('');
      continue;
    }
    const name = sectionName(line);
    if (name) {
      current = name;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)!.push(line);
  }
  return sections;
}

function cleanLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim());
}

function stripBullet(line: string): string {
  return line.replace(/^[•\-*▪◦]\s*/, '');
}

function splitSkills(lines: string[]): string[] {
  const found: string[] = [];
  for (const raw of lines) {
    const line = stripBullet(raw.trim());
    if (!line) continue;
    for (const part of line.split(/\s*[|,;•]\s*/)) {
      const item = stripChars(part, ' .');
      if (item.length > 1 && item.length <= 60) found.push(item);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of found) {
    const key = skill.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(skill);
    }
  }
  return out.slice(0, 60);
}

function looksLikeTitle(text: string): boolean {
  const low = text.toLowerCase();
  for (const word of TITLE_WORDS) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) {
      return true;
    }
  }
  return false;
}

function looksLikeCompany(text: string): boolean {
  const low = text.toLowerCase();
  for (const word of COMPANY_WORDS) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) {
      return true;
    }
  }
  return false;
}

/** Return (company, title, location) from header fragments. */
function splitHeader(rawParts: string[]): [string, string, string] {
  let parts = rawParts
    .map((part) => stripChars(collapseWhitespace(part), ' |,-–—'))
    .filter(Boolean);
  if (!parts.length) return ['', '', ''];

  if (parts.length === 1) {
    const text = parts[0];
    const atSplit = text.split(/\s+at\s+/i);
    if (atSplit.length === 2) {
      return [atSplit[1].trim(), atSplit[0].trim(), ''];
    }
    for (const sep of [' | ', ' — ', ' – ']) {
      if (text.includes(sep)) {
        parts = text.split(sep).map((part) => part.trim()).filter(Boolean);
        break;
      }
    }
    if (parts.length === 1) return [text, '', ''];
  }

  const a = parts[0] ?? '';
  const b = parts[1] ?? '';
  const aTitle = looksLikeTitle(a);
  const bTitle = looksLikeTitle(b);
  const aCompany = looksLikeCompany(a);
  const bCompany = looksLikeCompany(b);

  let company = '';
  let title = '';
  if (aTitle && !bTitle) {
    title = a;
    company = b;
  } else if (bTitle && !aTitle) {
    company = a;
    title = b;
  } else if (aCompany && !bCompany) {
    company = a;
    title = b;
  } else if (bCompany && !aCompany) {
    title = a;
    company = b;
  } else {
    company = a;
    title = b;
  }
  const location = parts.length > 2 ? parts[2] : '';
  return [company, title, location];
}

function splitExperienceBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    const isDateLine = YEAR_RANGE_RE.test(line) && line.length < 180;
    if (isDateLine && current.some((existing) => YEAR_RANGE_RE.test(existing))) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function parseExperience(lines: string[]): ExperienceItem[] {
  const entries: ExperienceItem[] = [];
  for (const block of splitExperienceBlocks(lines)) {
    let dateIdx: number | null = null;
    let match: RegExpExecArray | null = null;
    for (let idx = 0; idx < block.length; idx += 1) {
      const line = block[idx];
      const candidate = YEAR_RANGE_RE.exec(line);
      if (candidate && line.length < 180) {
        dateIdx = idx;
        match = candidate;
        break;
      }
    }
    if (dateIdx === null || !match) continue;

    const dateLine = block[dateIdx];
    const prefix = stripChars(dateLine.slice(0, match.index), ' |,-–—');
    const suffix = stripChars(dateLine.slice(match.index + match[0].length), ' |,-–—');
    const headerParts: string[] = [];
    const before = block.slice(0, dateIdx);
    if (prefix) before.push(prefix);
    for (const line of before) {
      if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) continue;
      if (line.includes('|')) {
        headerParts.push(...line.split('|').map((part) => part.trim()).filter(Boolean));
      } else {
        headerParts.push(line.trim());
      }
    }

    const body = [...(suffix ? [suffix] : []), ...block.slice(dateIdx + 1)];
    let bullets = body.filter((line) => line.trim()).map((line) => stripBullet(line).trim());
    let [company, title, location] = splitHeader(headerParts);
    if (!location && suffix && !/(19|20)\d{2}/.test(suffix)) {
      location = suffix;
    }

    // Some PDF exports put descriptive lines before the date line.
    if (!bullets.length && headerParts.length) {
      bullets = headerParts
        .slice(2)
        .filter((item) => item.length > 20)
        .map((item) => stripBullet(item).trim());
    }

    title = stripChars(title.replace(YEAR_RANGE_GLOBAL_RE, ''), ' -–—|,');
    company = stripChars(company.replace(YEAR_RANGE_GLOBAL_RE, ''), ' -–—|,');
    if (!company && !title && !bullets.length) continue;
    entries.push({
      company,
      title,
      location,
      start: (match[1] ?? '').trim(),
      end: (match[2] ?? '').trim(),
      context: '',
      bullets: bullets.slice(0, 12),
    });
  }
  return entries;
}

function parseEducation(lines: string[]): EducationItem[] {
  const items: EducationItem[] = [];
  for (const line of cleanLines(lines)) {
    const year = /(19|20)\d{2}/.exec(line);
    const parts = line.split(/\s*[|–—]\s*/);
    const institution = (parts[0] ?? line).trim();
    const degree = parts.length > 1 ? parts[1].trim() : '';
    items.push({
      institution,
      degree,
      location: '',
      year: year ? year[0] : '',
      details: parts.length === 1 ? line : '',
    });
  }
  return items.slice(0, 10);
}

export function parseCvHeuristic(text: string, fallbackName = ''): ParsedCV {
  const cleaned = cleanText(text);
  const sections = splitSections(cleaned);
  const header = cleanLines(sections.get('header') ?? []);

  let email = '';
  let phone = '';
  let linkedin = '';
  const emailMatch = EMAIL_RE.exec(cleaned);
  if (emailMatch) email = emailMatch[0];
  const phoneMatch = PHONE_RE.exec(cleaned);
  if (phoneMatch) phone = phoneMatch[0].trim();
  const linkedinMatch = LINKEDIN_RE.exec(cleaned);
  if (linkedinMatch) linkedin = linkedinMatch[0].replace(/[.,]+$/, '');

  let name = '';
  let headline = '';
  for (const line of header) {
    if (EMAIL_RE.test(line) || PHONE_RE.test(line) || LINKEDIN_RE.test(line)) continue;
    if (line.length > 80) continue;
    if (!name && !/\d/.test(line)) {
      name = stripChars(line, ' |');
      continue;
    }
    if (name && !headline && line.length < 120) {
      headline = stripChars(line, ' |');
      break;
    }
  }
  if (!name) {
    const first = cleaned.split(/\r?\n/).find((line) => line.trim()) ?? '';
    name = first.slice(0, 80);
  }
  if (!name && fallbackName) name = fallbackName;

  const experience = parseExperience(sections.get('experience') ?? []);
  const education = parseEducation(sections.get('education') ?? []);
  const skills = splitSkills(sections.get('skills') ?? []);
  const certifications = cleanLines(sections.get('certifications') ?? [])
    .filter((line) => line.length < 200)
    .map((line) => stripBullet(line).trim());
  const languages = splitSkills(sections.get('languages') ?? []);
  const achievements = cleanLines(sections.get('achievements') ?? []).map((line) =>
    stripBullet(line).trim(),
  );
  let summary = cleanLines(sections.get('summary') ?? []).join(' ').trim();
  if (!summary) {
    summary = header.slice(0, 8).join(' ').slice(0, 800);
  }

  const contact: ContactInfo = {
    email,
    phone,
    location: '',
    linkedin,
    website: '',
  };

  return {
    name,
    headline,
    contact,
    summary,
    experience,
    education,
    skills,
    certifications,
    languages,
    achievements,
  };
}

function tokens(text: string): string[] {
  const raw = String(text || '').toLowerCase().match(/[a-zA-ZÀ-ÿ0-9][a-zA-ZÀ-ÿ0-9+#./'-]{1,}/g) ?? [];
  const cleaned = raw.map((token) => stripChars(token, '.,;:()[]{}'));
  return cleaned.filter(
    (token) =>
      token.length > 2 &&
      !STOPWORDS.has(token) &&
      /[a-zA-ZÀ-ÿ]/.test(token),
  );
}

function stem(word: string): string {
  let value = stripChars(String(word || '').toLowerCase(), '.,;:()[]{}');
  if (value in SYNONYMS) return SYNONYMS[value];
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith('ed')) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith('s') && !/(ss|is|us)$/.test(value)) {
    return value.slice(0, -1);
  }
  return value;
}

function matchTokens(text: string): string[] {
  return tokens(text).map(stem);
}

function cleanPhrase(phrase: string): string {
  let value = stripChars(collapseWhitespace(phrase), ' .,;:-');
  const words = value.split(' ');
  while (words.length && PHRASE_TAIL_STOP.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(' ');
}

function counterMostCommon(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function keywords(text: string, limit = 40): string[] {
  const ranked = counterMostCommon(tokens(text), limit);
  const phraseRe = /\b(?:AI|ML|LLM|SaaS|B2B|B2C|P&L|go-to-market|product-led|data|cloud|security|fintech|healthtech|enterprise)\b(?:\s+[a-z]{3,}){0,2}/gi;
  const phrases: string[] = [];
  for (const match of text.matchAll(phraseRe)) {
    phrases.push(cleanPhrase(match[0].toLowerCase()));
  }
  for (const phrase of counterMostCommon(phrases, 12)) {
    if (phrase && phrase.length > 2 && !ranked.includes(phrase)) ranked.push(phrase);
  }
  return ranked.slice(0, limit);
}

function extractRequirements(text: string): [string[], string[], string[]] {
  const must: string[] = [];
  const nice: string[] = [];
  const responsibilities: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const item = sentence.replace(/^[•\-*▪◦\d.)]+\s*/, '').trim();
      if (item.length < 10 || seen.has(item)) continue;
      seen.add(item);
      const low = item.toLowerCase();
      if (
        ['must have', 'must-have', 'required', 'requirements', 'minimum of', 'at least', 'you have', 'proven', 'demonstrated'].some(
          (word) => low.includes(word),
        )
      ) {
        must.push(item);
      } else if (
        ['nice to have', 'nice-to-have', 'preferred', 'a plus', 'bonus'].some((word) =>
          low.includes(word),
        )
      ) {
        nice.push(item);
      } else if (
        ['responsib', 'you will', 'own ', 'lead ', 'drive ', 'build ', 'manage ', 'develop ', 'deliver ', 'partner '].some(
          (word) => low.includes(word),
        )
      ) {
        responsibilities.push(item);
      }
    }
  }
  return [must.slice(0, 15), nice.slice(0, 10), responsibilities.slice(0, 15)];
}

function overlap(requirement: string, candidateLower: string): number {
  const words = matchTokens(requirement).filter((word) => word.length > 3);
  if (!words.length) return 0;
  const hit = words.filter((word) => candidateLower.includes(word)).length;
  return hit / words.length;
}

function bestEvidence(requirement: string, candidateLines: string[]): string {
  const words = new Set(matchTokens(requirement).filter((word) => word.length > 3));
  let bestIdx = -1;
  let bestScore = 0;
  for (let idx = 0; idx < candidateLines.length; idx += 1) {
    const line = candidateLines[idx];
    if (line.length < 20) continue;
    const low = matchTokens(line).join(' ');
    const score = [...words].filter((word) => low.includes(word)).length;
    if (score > bestScore) {
      bestIdx = idx;
      bestScore = score;
    }
  }
  if (bestIdx < 0) return '';

  // PDF/DOCX exports wrap bullets across lines. Join the continuation so the
  // evidence reads as a complete thought instead of stopping mid-sentence.
  const parts = [stripBullet(candidateLines[bestIdx].trim())];
  let cursor = bestIdx;
  while (
    parts.length &&
    parts.join(' ').length < 360 &&
    !/[.!?;:]$/.test(parts[parts.length - 1]) &&
    cursor + 1 < candidateLines.length
  ) {
    const following = candidateLines[cursor + 1].trim();
    if (/^[•\-*▪◦]/.test(following) || sectionName(following)) break;
    parts.push(following);
    cursor += 1;
  }
  return parts.join(' ').slice(0, 400);
}

export function detectLanguage(text: string): string {
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  return 'en';
}

function splitAfterColon(line: string): string {
  const index = line.indexOf(':');
  return index === -1 ? line : line.slice(index + 1).trim();
}

export interface AnalyzeJobOptions {
  cvs?: Record<string, any>[];
  fallbackTitle?: string;
  fallbackCompany?: string;
}

export function analyzeJobHeuristic(
  jobDescription: string,
  candidateText: string,
  cvs: Record<string, any>[] | null = null,
  fallbackTitle = '',
  fallbackCompany = '',
): JobAnalysis {
  const jd = cleanText(jobDescription);
  const language = detectLanguage(jd);
  const lines = jd.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let title = fallbackTitle;
  let company = fallbackCompany;

  for (const line of lines) {
    const low = line.toLowerCase();
    if (!title && ['job title', 'position', 'role:', 'title:'].some((prefix) => low.includes(prefix))) {
      title = splitAfterColon(line);
    }
    if (!company && ['company:', 'organization:', 'employer:'].some((prefix) => low.includes(prefix))) {
      company = splitAfterColon(line);
    }
  }
  if (!title && lines.length) title = lines[0].slice(0, 120);

  const [must, nice, responsibilities] = extractRequirements(jd);
  const keywordList = keywords(jd, 45);
  const candidateLower = candidateText.toLowerCase();
  const candidateStemmed = matchTokens(candidateText).join(' ');
  const candidateLines = candidateText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const strengths: Evidence[] = [];
  const gaps: Gap[] = [];
  must.forEach((requirement, idx) => {
    const score = overlap(requirement, candidateStemmed);
    if (score >= 0.34) {
      strengths.push({
        requirement,
        evidence: bestEvidence(requirement, candidateLines),
        source: 'source CV',
      });
    } else {
      gaps.push({
        requirement,
        severity: idx < 5 ? 'high' : 'medium',
        mitigation: 'Do not claim this. Address adjacent, evidence-backed experience only.',
      });
    }
  });

  const coverage = strengths.length / Math.max(1, must.length);
  const keywordHits = keywordList.filter((kw) => candidateLower.includes(kw)).length;
  const keywordCoverage = keywordHits / Math.max(1, keywordList.length);
  let score = Math.trunc(pyRound(100 * (0.65 * coverage + 0.35 * keywordCoverage)));
  score = Math.max(0, Math.min(100, score));
  const level = score >= 75 ? 'strong' : score >= 50 ? 'moderate' : 'weak';

  const supported = keywordList.filter((kw) => candidateLower.includes(kw)).slice(0, 30);
  let recommendedCvId: number | null = null;
  let recommendedVertical = '';
  if (cvs && cvs.length) {
    let bestScore = -1;
    for (const cv of cvs) {
      const cvText = String(cv.raw_text ?? '').toLowerCase();
      const cvScore = keywordList.filter((kw) => cvText.includes(kw)).length;
      if (cvScore > bestScore) {
        bestScore = cvScore;
        recommendedCvId = cv.id ?? null;
        recommendedVertical = cv.vertical ?? '';
      }
    }
  }

  const plan = [
    'Lead with the achievements that prove the must-have requirements.',
    "Mirror the posting's exact terminology only where the source CV supports it.",
    'Keep company names, titles, dates, and metrics unchanged.',
    'Use a single-column, ATS-safe layout with standard section headings.',
  ];
  if (supported.length) {
    plan.push(`Emphasise supported keywords: ${supported.slice(0, 12).join(', ')}.`);
  }
  if (gaps.length) {
    plan.push(`Do not claim: ${gaps.slice(0, 4).map((gap) => gap.requirement).join('; ')}.`);
  }

  const jdLower = jd.toLowerCase();
  return {
    job_title: title,
    company,
    location: '',
    seniority: ['chief', 'vp', 'vice president', 'head of', 'director'].some((word) =>
      jdLower.includes(word),
    )
      ? 'executive'
      : '',
    language,
    summary:
      `Offline heuristic review: ${score}/100 match. ` +
      `${strengths.length} of ${must.length} explicit requirements have direct evidence.`,
    must_have: must,
    nice_to_have: nice,
    responsibilities,
    ats_keywords: keywordList,
    culture_signals: [],
    red_flags: [],
    match_score: score,
    match_level: level,
    strengths,
    gaps,
    recommended_cv_id: recommendedCvId,
    recommended_vertical: recommendedVertical,
    tailoring_plan: plan,
    keywords_to_include: supported,
    do_not_claim: gaps.map((gap) => gap.requirement),
    analyzer_notes: 'Generated by the deterministic offline analyser (no LLM configured).',
  };
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).map(stem));
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** Build a compact competency list from supported terms and relevant skills. */
function buildCompetencies(
  supported: string[],
  skills: string[],
  jobTerms: Set<string>,
  limit = 12,
): string[] {
  const weak = new Set([
    'head', 'own', 'looking', 'seeking', 'organisation', 'organization',
    'scale', 'scaling', 'nice', 'hiring', 'responsibilities', 'high-performing',
    'cost',
  ]);
  const chosen: string[] = [];

  const add = (raw: string): void => {
    const item = stripChars(collapseWhitespace(raw), ' .,;:-');
    if (item.length < 2 || weak.has(item.toLowerCase())) return;
    const words = wordSet(item);
    for (const existing of chosen) {
      if (isSubset(words, wordSet(existing))) return;
    }
    chosen.push(item);
  };

  for (const keyword of supported) {
    if (keyword.includes(' ')) add(keyword);
  }
  for (const keyword of supported) {
    if (!keyword.includes(' ')) add(keyword);
  }
  for (const skill of skills) {
    const low = skill.toLowerCase();
    if (jobTerms.has(low) || low.split(/\s+/).some((word) => jobTerms.has(word))) {
      add(skill);
    }
  }
  return chosen.slice(0, limit);
}

export function tailorHeuristic(
  parsed: ParsedCV,
  analysis: JobAnalysis,
  sourceText: string,
  context: string,
  language: string | null = null,
): TailoredCV {
  const sourceLower = `${sourceText}\n${context}`.toLowerCase();
  let supported = analysis.keywords_to_include.filter((kw) =>
    sourceLower.includes(kw.toLowerCase()),
  );
  if (!supported.length) {
    supported = analysis.ats_keywords
      .filter((kw) => sourceLower.includes(kw.toLowerCase()))
      .slice(0, 15);
  }

  let summary = parsed.summary.trim();
  if (!summary) summary = cleanText(context).slice(0, 800);
  if (!summary) summary = 'Experienced professional. See detailed experience below.';

  const experience: ExperienceItem[] = [];
  for (const entry of parsed.experience) {
    const scored = entry.bullets.map((bullet, idx) => {
      const low = bullet.toLowerCase();
      const score = supported.filter((kw) => low.includes(kw.toLowerCase())).length;
      return { score, idx, bullet };
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const selected = scored.slice(0, 8);
    // Preserve original order among selected bullets.
    selected.sort((a, b) => a.idx - b.idx);
    experience.push({
      ...entry,
      bullets: selected.map((item) => item.bullet),
    });
  }

  const competencies =
    buildCompetencies(
      supported,
      parsed.skills,
      new Set(analysis.ats_keywords.map((kw) => kw.toLowerCase())),
    ).slice(0, 12) || parsed.skills.slice(0, 12);

  const grounding: Evidence[] = analysis.strengths.slice(0, 12).map((item) => ({
    requirement: item.requirement,
    evidence: item.evidence,
    source: item.source || 'source CV',
  }));

  return {
    language: language || analysis.language || 'en',
    name: parsed.name,
    headline: parsed.headline,
    contact: { ...parsed.contact },
    summary,
    core_competencies: competencies,
    experience,
    education: parsed.education,
    certifications: parsed.certifications,
    skills: parsed.skills,
    languages: parsed.languages,
    ats_keywords: supported,
    change_log: [
      'Selected and reordered existing achievements by relevance to the posting.',
      'Kept every employer, title, date, and metric from the source CV unchanged.',
      'No unsupported requirements were added.',
    ],
    grounding,
  };
}

/** Build the evidence corpus handed to the headhunter. */
export function candidateDigest(
  context: string,
  cvs: Record<string, any>[],
  maxChars = 60000,
): string {
  const parts = [`## CANDIDATE CONTEXT\n${cleanText(context)}`];
  for (const cv of cvs) {
    parts.push(
      `\n## CV VERSION ${cv.id} — VERTICAL: ${cv.vertical ?? ''}\n` +
        cleanText(String(cv.raw_text ?? '')),
    );
  }
  let digest = parts.join('\n');
  if (digest.length > maxChars) {
    digest = `${digest.slice(0, maxChars)}\n… [truncated to fit the model context]`;
  }
  return digest;
}
