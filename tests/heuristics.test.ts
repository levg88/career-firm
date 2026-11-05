import { describe, expect, it } from 'vitest';

import { removeUnsupportedKeywords, validateGrounding } from '../src/agents/grounding';
import {
  analyzeJobHeuristic,
  parseCvHeuristic,
  tailorHeuristic,
} from '../src/documents/heuristics';
import {
  jobAnalysisSchema,
  tailoredCvSchema,
} from '../src/models';
import { SAMPLE_CV, SAMPLE_JD } from './helpers';

describe('heuristics', () => {
  it('parses roles and identity from the sample CV', () => {
    const parsed = parseCvHeuristic(SAMPLE_CV);
    expect(parsed.name).toBe('Jane Doe');
    expect(parsed.headline).toBe('VP Engineering | AI Platforms');
    expect(parsed.contact.email).toBe('jane.doe@example.com');
    expect(parsed.experience).toHaveLength(2);
    const first = parsed.experience[0];
    expect(first.company).toBe('Acme Corp');
    expect(first.title).toBe('VP Engineering');
    expect(first.location).toBe('San Francisco');
    expect(first.start).toBe('2020');
    expect(first.end).toBe('Present');
    expect(first.bullets).toHaveLength(3);
    expect(parsed.education[0].institution).toBe('Stanford University');
    expect(parsed.skills).toContain('Python');
  });

  it('maps evidence for the sample job', () => {
    const analysis = analyzeJobHeuristic(SAMPLE_JD, SAMPLE_CV);
    expect(analysis.job_title).toBe('VP Engineering, AI Platform');
    expect(analysis.company).toBe('Nimbus AI');
    expect(analysis.match_score).toBeGreaterThanOrEqual(50);
    expect(['strong', 'moderate']).toContain(analysis.match_level);
    expect(analysis.must_have.length).toBeGreaterThanOrEqual(2);
    expect(analysis.strengths.length).toBeGreaterThanOrEqual(1);
    expect(
      analysis.strengths.some((item) => item.evidence.includes('LLM')),
    ).toBe(true);
    expect(
      analysis.ats_keywords.includes('LLM') || analysis.ats_keywords.includes('llm'),
    ).toBe(true);
  });

  it('joins wrapped evidence lines and filters keyword noise', () => {
    const candidate =
      '- Executive engineering leader focused on AI platforms, data infrastructure, and\n' +
      'enterprise SaaS.\n';
    const job =
      'Must have engineering leadership and platform experience.\n' +
      'Nice to have 10+ years of cloud cost optimization.\n';
    const analysis = analyzeJobHeuristic(job, candidate);
    expect(analysis.strengths.length).toBeGreaterThan(0);
    expect(analysis.strengths[0].evidence).toBe(
      'Executive engineering leader focused on AI platforms, data infrastructure, ' +
        'and enterprise SaaS.',
    );
    expect(analysis.ats_keywords.every((keyword) => !keyword.startsWith('10'))).toBe(true);
    expect(
      analysis.ats_keywords.every(
        (keyword) => !keyword.endsWith(' and') && !keyword.endsWith(' company'),
      ),
    ).toBe(true);
  });

  it('builds clean competencies', () => {
    const job =
      'Head of AI Platform\n' +
      'Must have LLM platforms and enterprise customers.\n' +
      'Nice to have cloud cost optimization.\n' +
      'Own the platform roadmap and drive revenue.\n';
    const parsed = parseCvHeuristic(SAMPLE_CV);
    const analysis = analyzeJobHeuristic(job, SAMPLE_CV);
    const tailored = tailorHeuristic(parsed, analysis, SAMPLE_CV, '');
    const competencies = tailored.core_competencies.map((item) => item.toLowerCase());
    expect(competencies.length).toBeGreaterThan(0);
    expect(competencies).not.toContain('head');
    expect(competencies).not.toContain('own');
    expect(tailored.core_competencies.length).toBeLessThanOrEqual(12);
  });

  it('preserves facts while tailoring', () => {
    const parsed = parseCvHeuristic(SAMPLE_CV);
    const analysis = analyzeJobHeuristic(SAMPLE_JD, SAMPLE_CV);
    const tailored = tailorHeuristic(parsed, analysis, SAMPLE_CV, 'Executive leader.');
    expect(tailored.experience.map((item) => item.company)).toEqual([
      'Acme Corp',
      'Beta Systems',
    ]);
    expect(tailored.experience[0].start).toBe('2020');
    expect(tailored.experience[0].bullets.join(' ')).toContain('45');
    const warnings = validateGrounding(
      tailored,
      SAMPLE_CV,
      'Executive leader.',
      analysis,
    );
    expect(warnings).toEqual([]);
  });

  it('flags invented companies and metrics', () => {
    const source = 'Acme Corp\nLed a team of 5.\n2019 - 2020';
    const analysis = jobAnalysisSchema.parse({
      do_not_claim: ['Series C fundraising'],
    });
    const tailored = tailoredCvSchema.parse({
      name: 'Jane',
      contact: { email: 'jane@example.com' },
      summary: 'Series C fundraising expert.',
      experience: [
        {
          company: 'Globex',
          title: 'VP',
          start: '2018',
          end: '2024',
          bullets: ['Grew revenue 99%.'],
        },
      ],
    });
    const joined = validateGrounding(tailored, source, '', analysis).join('\n');
    expect(joined).toContain('Globex');
    expect(joined).toContain('99');
    expect(joined).toContain('2018');
    expect(joined).toContain('Series C');
  });

  it('removes unsupported keywords', () => {
    const cv = tailoredCvSchema.parse({
      ats_keywords: ['LLM', 'Blockchain', 'Cloud'],
    });
    const cleaned = removeUnsupportedKeywords(cv, SAMPLE_CV, '');
    expect(cleaned.ats_keywords).toContain('LLM');
    expect(cleaned.ats_keywords).toContain('Cloud');
    expect(cleaned.ats_keywords).not.toContain('Blockchain');
  });
});
