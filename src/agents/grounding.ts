/**
 * @file Deterministic truthfulness checks for generated CVs.
 *
 * Provides {@link validateGrounding} and {@link removeUnsupportedKeywords}, which
 * compare a tailored CV against the source CV/context and flag employers, dates,
 * metrics, contact details, claims, and ATS keywords that are not supported by
 * the source. These act as a safety net on top of the LLM's own constraints.
 */

import type { JobAnalysis, TailoredCV } from '../models';

/** Normalise text for fuzzy comparison (lower-case, unify punctuation, collapse whitespace). */
function norm(text: string): string {
  let value = (text || '').toLowerCase();
  value = value.replace(/–/g, '-').replace(/—/g, '-').replace(/’/g, "'");
  value = value.replace(/[^a-z0-9\u0590-\u05ff\u0600-\u06ff\u0400-\u04ff\u4e00-\u9fff]+/g, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

/** Extract all numeric tokens from text into a set for comparison. */
function numbers(text: string): Set<string> {
  const cleaned = (text || '').replace(/,/g, '');
  return new Set(cleaned.match(/\d+(?:\.\d+)?/g) ?? []);
}

/** Check whether a company name is supported by the corpus (exact or token overlap). */
function companySupported(company: string, corpusNorm: string): boolean {
  const companyNorm = norm(company);
  if (!companyNorm) return true;
  if (corpusNorm.includes(companyNorm)) return true;
  const tokens = companyNorm.split(' ').filter((token) => token.length > 2);
  if (!tokens.length) return true;
  const hits = tokens.filter((token) => corpusNorm.includes(token)).length;
  return hits / tokens.length >= 0.75;
}

/**
 * Flag plausible-but-unsupported claims. Deterministic, conservative.
 *
 * This is a safety net, not a truth oracle: it catches new employers, years,
 * metrics, and contact details that do not appear anywhere in the source.
 */
export function validateGrounding(
  cv: TailoredCV,
  sourceText: string,
  context: string,
  analysis: JobAnalysis,
): string[] {
  const corpus = `${sourceText}\n${context}`;
  const corpusNorm = norm(corpus);
  const corpusNumbers = numbers(corpus);
  const warnings: string[] = [];

  if (!cv.experience.length) {
    warnings.push('No experience entries were produced; review the source CV before sending.');
  }

  for (const item of cv.experience) {
    if (item.company && !companySupported(item.company, corpusNorm)) {
      warnings.push(
        `Unverified employer '${item.company}'. It does not appear in the source CV/context.`,
      );
    }
    for (const year of `${item.start} ${item.end}`.match(/(?:19|20)\d{2}/g) ?? []) {
      if (!corpusNumbers.has(year)) {
        warnings.push(`Unverified date '${year}' in ${item.company || 'an experience entry'}.`);
      }
    }
    for (const bullet of item.bullets) {
      for (const number of numbers(bullet)) {
        if (!corpusNumbers.has(number)) {
          warnings.push(
            `Unverified metric '${number}' in a bullet for ${
              item.company || 'an experience entry'
            }: ${bullet.slice(0, 140)}`,
          );
        }
      }
    }
  }

  if (cv.contact.email && !corpusNorm.includes(norm(cv.contact.email))) {
    warnings.push(`Email '${cv.contact.email}' does not appear in the source profile.`);
  }
  if (cv.contact.phone) {
    const digits = cv.contact.phone.replace(/\D/g, '');
    if (digits && !corpus.replace(/\D/g, '').includes(digits)) {
      warnings.push(`Phone '${cv.contact.phone}' does not appear in the source profile.`);
    }
  }

  const generatedText = [
    cv.summary,
    cv.headline,
    ...cv.core_competencies,
    ...cv.skills,
    ...cv.experience.flatMap((item) => item.bullets),
  ].join(' ');
  const generatedNorm = norm(generatedText);
  for (const claim of analysis.do_not_claim) {
    const claimNorm = norm(claim);
    if (claimNorm.length >= 12 && generatedNorm.includes(claimNorm)) {
      warnings.push(`Generated text appears to claim a stated gap: ${claim.slice(0, 160)}`);
    }
  }

  const unsupportedKeywords = cv.ats_keywords.filter(
    (keyword) => keyword && !corpusNorm.includes(norm(keyword)),
  );
  if (unsupportedKeywords.length) {
    warnings.push(
      `ATS keywords not found in the source were removed: ${unsupportedKeywords
        .slice(0, 15)
        .join(', ')}`,
    );
  }

  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const warning of warnings) {
    if (!seen.has(warning)) {
      seen.add(warning);
      unique.push(warning);
    }
  }
  return unique.slice(0, 40);
}

/**
 * Strip ATS keywords that are not supported by the source text/context.
 * @returns A new tailored CV with the filtered keyword list.
 */
export function removeUnsupportedKeywords(
  cv: TailoredCV,
  sourceText: string,
  context: string,
): TailoredCV {
  const corpusNorm = norm(`${sourceText}\n${context}`);
  const supported = cv.ats_keywords.filter(
    (keyword) => keyword && corpusNorm.includes(norm(keyword)),
  );
  if (supported.length === cv.ats_keywords.length) return cv;
  return { ...cv, ats_keywords: supported };
}
