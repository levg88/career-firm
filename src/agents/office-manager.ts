/**
 * @file Office Manager agent: parses a client CV into a structured record.
 *
 * The {@link OfficeManager} class turns raw CV text into a {@link ParsedCV},
 * preserving facts verbatim. Also builds a compact profile digest for downstream
 * agents. Supports LLM and deterministic heuristic modes.
 */

import path from 'node:path';

import { Settings } from '../config';
import { parseCvHeuristic } from '../documents/heuristics';
import { LLMClient } from '../llm/base';
import { MockClient } from '../llm/mock';
import { parsedCvSchema, type ParsedCV } from '../models';
import { agentFromDefinition } from './base';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { recordHeuristicRun, runAgent } from './runner';
import { schemaForAgent } from './schema';

/** Reads the client's CVs and context, and keeps the record faithful. */
export class OfficeManager {
  readonly definition: AgentDefinition;
  readonly role: string;
  settings: Settings;
  llm: LLMClient;

  constructor(settings: Settings, llm: LLMClient) {
    this.settings = settings;
    this.llm = llm;
    this.definition = getAgentDefinition('office_manager', { extraDirs: [settings.agentsDir] });
    this.role = this.definition.role;
  }

  /**
   * Parse a CV's raw text into a structured {@link ParsedCV}.
   * @param text Raw CV text.
   * @param options Optional filename and workflow run id for audit logging.
   */
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

    const agent = agentFromDefinition(this.definition, this.llm, this.settings);
    const task = renderAgentTask(this.definition, { filename: filename || 'unknown' });

    let parsed: ParsedCV;
    try {
      const result = await runAgent(this.settings, agent, {
        workflow: this.definition.workflow,
        role: this.role,
        task,
        context: text,
        schema: schemaForAgent(this.definition),
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
