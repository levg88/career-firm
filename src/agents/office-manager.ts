import path from 'node:path';

import { Settings } from '../config';
import { parseCvHeuristic } from '../documents/heuristics';
import { LLMClient } from '../llm/base';
import { MockClient } from '../llm/mock';
import { parsedCvSchema, type ParsedCV } from '../models';
import { Agent } from './base';
import { OFFICE_MANAGER } from './prompts';
import { recordHeuristicRun, runAgent } from './runner';

/** Reads the client's CVs and context, and keeps the record faithful. */
export class OfficeManager {
  readonly role = 'office_manager';
  settings: Settings;
  llm: LLMClient;

  constructor(settings: Settings, llm: LLMClient) {
    this.settings = settings;
    this.llm = llm;
  }

  async parseCv(
    text: string,
    options: { filename?: string; workflowRunId?: number | null } = {},
  ): Promise<ParsedCV> {
    const filename = options.filename ?? '';
    let fallbackName = path.parse(filename || '').name.replace(/_/g, ' ').replace(/-/g, ' ').trim();
    fallbackName = fallbackName ? fallbackName.slice(0, 80) : '';

    if (this.settings.isMock || this.llm instanceof MockClient) {
      const parsed = parseCvHeuristic(text, fallbackName);
      recordHeuristicRun(this.settings, {
        workflow: 'office_manager',
        role: this.role,
        inputPayload: { filename, chars: text.length },
        output: parsed as unknown as Record<string, unknown>,
        workflowRunId: options.workflowRunId ?? null,
      });
      return parsed;
    }

    const agent = new Agent(
      {
        name: 'office_manager',
        role: this.role,
        systemPrompt: OFFICE_MANAGER,
        temperature: 0.0,
      },
      this.llm,
      this.settings,
    );
    const task =
      'Parse the CV in the CONTEXT section into the ParsedCV schema. ' +
      `Filename: ${filename || 'unknown'}. ` +
      'If the name cannot be determined, use the filename stem only as a last resort.';

    let parsed: ParsedCV;
    try {
      const result = await runAgent(this.settings, agent, {
        workflow: 'office_manager',
        role: this.role,
        task,
        context: text,
        schema: parsedCvSchema,
        workflowRunId: options.workflowRunId ?? null,
      });
      parsed = parsedCvSchema.parse(result.data ?? {});
    } catch (error) {
      if (!this.settings.allowHeuristicFallback) throw error;
      parsed = parseCvHeuristic(text, fallbackName);
      const err = error instanceof Error ? error : new Error(String(error));
      const note = `Structured parse fallback used (${err.name}).`;
      parsed = { ...parsed, summary: `${parsed.summary}\n\n${note}`.trim() };
    }

    if (!parsed.name) parsed = { ...parsed, name: fallbackName };
    return parsed;
  }

  /** A compact, factual profile digest for downstream agents. */
  buildProfileContext(contextText: string, cvs: Record<string, any>[]): string {
    const parts = [`# CLIENT CONTEXT\n${contextText.trim()}`];
    parts.push('\n# CV INVENTORY');
    for (const cv of cvs) {
      parts.push(`- CV ID ${cv.id} | vertical: ${cv.vertical ?? ''} | file: ${cv.filename ?? ''}`);
    }
    return parts.join('\n');
  }
}
