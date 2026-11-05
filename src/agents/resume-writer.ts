import { Settings } from '../config';
import { tailorHeuristic } from '../documents/heuristics';
import { LLMClient } from '../llm/base';
import { MockClient } from '../llm/mock';
import {
  tailoredCvSchema,
  type ExperienceItem,
  type JobAnalysis,
  type ParsedCV,
  type TailoredCV,
} from '../models';
import { Agent } from './base';
import { removeUnsupportedKeywords, validateGrounding } from './grounding';
import { RESUME_WRITER } from './prompts';
import { recordHeuristicRun, runAgent } from './runner';

export interface WriteOptions {
  analysis: JobAnalysis;
  parsed: ParsedCV;
  sourceText: string;
  context: string;
  language: string;
  workflowRunId?: number | null;
}

/** Elite executive resume writer with a deterministic grounding check. */
export class ResumeWriter {
  readonly role = 'resume_writer';
  settings: Settings;
  llm: LLMClient;

  constructor(settings: Settings, llm: LLMClient) {
    this.settings = settings;
    this.llm = llm;
  }

  async write(options: WriteOptions): Promise<[TailoredCV, string[]]> {
    const { analysis, parsed, sourceText, context, language, workflowRunId = null } = options;

    if (this.settings.isMock || this.llm instanceof MockClient) {
      let cv = tailorHeuristic(parsed, analysis, sourceText, context, language);
      const warnings = validateGrounding(cv, sourceText, context, analysis);
      cv = removeUnsupportedKeywords(cv, sourceText, context);
      recordHeuristicRun(this.settings, {
        workflow: 'tailoring',
        role: this.role,
        inputPayload: {
          analysis_score: analysis.match_score,
          source_chars: sourceText.length,
        },
        output: { tailored_cv: cv, warnings } as unknown as Record<string, unknown>,
        workflowRunId,
      });
      return [cv, warnings];
    }

    const task =
      'Write the tailored CV for this role. Use the analysis and the source CV below.\n\n' +
      `## TARGET LANGUAGE\n${language}\n\n` +
      '## HEADHUNTER ANALYSIS\n' +
      `${JSON.stringify(analysis, null, 2)}\n\n` +
      '## SOURCE CV (AUTHORITATIVE — do not add facts)\n' +
      `${JSON.stringify(parsed, null, 2)}\n\n` +
      '## ORIGINAL SOURCE TEXT (for exact wording and metrics)\n' +
      sourceText.slice(0, 24000);

    const agent = new Agent(
      {
        name: 'resume_writer',
        role: this.role,
        systemPrompt: RESUME_WRITER,
        temperature: 0.25,
      },
      this.llm,
      this.settings,
    );

    let cv: TailoredCV;
    try {
      const result = await runAgent(this.settings, agent, {
        workflow: 'tailoring',
        role: this.role,
        task,
        context,
        schema: tailoredCvSchema,
        workflowRunId,
      });
      cv = tailoredCvSchema.parse(result.data ?? {});
    } catch (error) {
      if (!this.settings.allowHeuristicFallback) throw error;
      cv = tailorHeuristic(parsed, analysis, sourceText, context, language);
      const err = error instanceof Error ? error : new Error(String(error));
      cv = {
        ...cv,
        change_log: [
          ...cv.change_log,
          `Model writing failed (${err.name}); deterministic tailoring fallback used.`,
        ],
      };
    }

    cv = this.normalise(cv, parsed, language);
    cv = removeUnsupportedKeywords(cv, sourceText, context);
    const warnings = validateGrounding(cv, sourceText, context, analysis);
    return [cv, warnings];
  }

  private normalise(cv: TailoredCV, parsed: ParsedCV, language: string): TailoredCV {
    const updates: Partial<TailoredCV> = {};
    if (!cv.name) updates.name = parsed.name;
    if (!cv.headline) updates.headline = parsed.headline;
    if (!cv.summary) updates.summary = parsed.summary;
    if (!cv.language) updates.language = language;

    const contact = cv.contact;
    const contactUpdates = {
      email: contact.email || parsed.contact.email,
      phone: contact.phone || parsed.contact.phone,
      location: contact.location || parsed.contact.location,
      linkedin: contact.linkedin || parsed.contact.linkedin,
      website: contact.website || parsed.contact.website,
    };
    if (JSON.stringify(contactUpdates) !== JSON.stringify(contact)) {
      updates.contact = contactUpdates;
    }

    if (!cv.experience.length && parsed.experience.length) {
      updates.experience = parsed.experience;
    } else if (cv.experience.length === parsed.experience.length) {
      // Fill any fields the writer omitted, without overwriting its choices.
      const merged: ExperienceItem[] = cv.experience.map((generated, index) => {
        const source = parsed.experience[index];
        return {
          ...generated,
          company: generated.company || source.company,
          title: generated.title || source.title,
          start: generated.start || source.start,
          end: generated.end || source.end,
          location: generated.location || source.location,
        };
      });
      updates.experience = merged;
    }

    if (!cv.education.length && parsed.education.length) updates.education = parsed.education;
    if (!cv.certifications.length && parsed.certifications.length) {
      updates.certifications = parsed.certifications;
    }
    if (!cv.skills.length && parsed.skills.length) updates.skills = parsed.skills;
    if (!cv.languages.length && parsed.languages.length) updates.languages = parsed.languages;
    if (!cv.change_log.length) {
      updates.change_log = ['Tailored from the selected source CV; facts preserved.'];
    }

    return { ...cv, ...updates };
  }
}
