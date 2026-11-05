import { describe, expect, it } from 'vitest';

import {
  jobAnalysisSchema,
  parsedCvSchema,
  tailoredCvSchema,
} from '../src/models';

describe('models', () => {
  it('accepts LLM shorthand for job analysis', () => {
    const analysis = jobAnalysisSchema.parse({
      must_haves: ['Lead engineering'],
      nice_to_haves: 'Cloud cost',
      keywords: ['LLM', 'Platform'],
      score: '85%',
      strengths: ['Scaled teams'],
      gaps: ['Board reporting'],
      recommended_cv: '2',
    });
    expect(analysis.must_have).toEqual(['Lead engineering']);
    expect(analysis.nice_to_have).toEqual(['Cloud cost']);
    expect(analysis.ats_keywords).toEqual(['LLM', 'Platform']);
    expect(analysis.match_score).toBe(85);
    expect(analysis.strengths[0].requirement).toBe('Scaled teams');
    expect(analysis.gaps[0].requirement).toBe('Board reporting');
    expect(analysis.recommended_cv_id).toBe(2);
  });

  it('maps tailored CV aliases and contact fallback', () => {
    const cv = tailoredCvSchema.parse({
      name: 'Jane Doe',
      professional_summary: 'Executive.',
      competencies: ['AI', 'Platforms'],
      keywords: ['LLM'],
      email: 'jane@example.com',
      phone: '+1 555 0100',
      experience: [
        {
          company: 'Acme',
          title: 'VP',
          dates: '2020 - Present',
          achievements: ['Led 45 engineers'],
        },
      ],
    });
    expect(cv.summary).toBe('Executive.');
    expect(cv.core_competencies).toEqual(['AI', 'Platforms']);
    expect(cv.ats_keywords).toEqual(['LLM']);
    expect(cv.contact.email).toBe('jane@example.com');
    expect(cv.experience[0].start).toBe('2020');
    expect(cv.experience[0].end).toBe('Present');
    expect(cv.experience[0].bullets).toEqual(['Led 45 engineers']);
  });

  it('accepts parsed CV shorthand', () => {
    const parsed = parsedCvSchema.parse({
      name: 'Jane',
      work_experience: [{ company: 'Acme', title: 'VP', dates: '2019 - 2024' }],
      education_history: [{ institution: 'Stanford', degree: 'MS' }],
      professional_summary: 'Executive.',
    });
    expect(parsed.summary).toBe('Executive.');
    expect(parsed.experience[0].start).toBe('2019');
    expect(parsed.education[0].institution).toBe('Stanford');
  });
});
