/**
 * @file Agent runtime: provider-agnostic tool-calling agent loop, tool registry,
 *       and shared agent contracts.
 *
 * Defines the {@link Agent} class that drives a multi-step conversation with an
 * LLM, dispatching tool calls until a final answer (optionally JSON-validated)
 * is produced. Also defines {@link ToolRegistry}, {@link Tool}, {@link AgentSpec},
 * {@link AgentResult}, and the {@link AgentError} type used across the firm.
 */

import { toJSONSchema, type ZodType } from 'zod';

import { Settings } from '../config';
import { LLMClient, LLMError, LLMResponse, parseJsonObject } from '../llm/base';
import type { AgentDefinition } from './definitions';

/**
 * Error thrown when an agent fails to produce a valid final answer within
 * its step budget or when JSON parsing ultimately fails.
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * A callable tool exposed to an agent. The handler receives parsed arguments
 * and returns either a string or a JSON-serialisable value.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, any>) => unknown;
}

/**
 * Convert a {@link Tool} into the JSON-schema function descriptor expected by
 * LLM providers' tool-calling APIs.
 * @param tool The tool to describe.
 */
export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Registry of named tools available to an agent. Executes tool calls safely,
 * returning JSON-encoded results (or errors) truncated to a sane size.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  schemas(): Record<string, unknown>[] {
    return [...this.tools.values()].map(toolSchema);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
    try {
      const result = await tool.handler(args);
      if (typeof result === 'string') return result.slice(0, 120000);
      return JSON.stringify(result ?? null).slice(0, 120000);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return JSON.stringify({ ok: false, error: `${err.constructor.name}: ${err.message}` }).slice(0, 120000);
    }
  }
}

/**
 * Static configuration describing an agent's identity and prompting.
 */
export interface AgentSpec {
  name: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number | null;
}

/**
 * Outcome of a single {@link Agent.run} invocation, including token usage.
 */
export interface AgentResult {
  text: string;
  data: Record<string, any> | null;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  response: LLMResponse | null;
}

function schemaJson(schema: ZodType): string {
  try {
    return JSON.stringify(toJSONSchema(schema, { io: 'input' }), null, 2);
  } catch {
    return '{}';
  }
}

/**
 * A small provider-agnostic tool-calling agent. Runs a multi-step loop,
 * dispatching tool calls and (optionally) validating JSON output.
 */
export class Agent {
  spec: AgentSpec;
  llm: LLMClient;
  settings: Settings;
  tools: ToolRegistry;

  constructor(spec: AgentSpec, llm: LLMClient, settings: Settings, tools?: ToolRegistry) {
    this.spec = spec;
    this.llm = llm;
    this.settings = settings;
    this.tools = tools ?? new ToolRegistry();
  }

  /**
   * Run the agent on a task.
   * @param task The user-facing task description.
   * @param options Optional context, output schema, and step limit.
   */
  async run(
    task: string,
    options: { context?: string; schema?: ZodType; maxSteps?: number } = {},
  ): Promise<AgentResult> {
    let system = this.spec.systemPrompt.trim();
    if (options.schema) {
      system +=
        '\n\nOUTPUT JSON\n' +
        'Return only one valid JSON object, with no prose before or after it. ' +
        'It must conform to this JSON Schema:\n' +
        schemaJson(options.schema);
    }

    let user = task.trim();
    if (options.context?.trim()) {
      user += '\n\nCONTEXT\n' + options.context.trim();
    }
    const messages: Record<string, any>[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const toolSchemas = this.tools.schemas();
    let promptTokens = 0;
    let completionTokens = 0;
    let jsonAttempts = 0;
    let steps = 0;
    const limit = options.maxSteps ?? this.settings.maxAgentSteps;

    for (let step = 1; step <= limit; step += 1) {
      steps = step;
      const llmResponse = await this.llm.complete(messages, {
        tools: toolSchemas.length ? toolSchemas : undefined,
        temperature: this.spec.temperature ?? 0.2,
        maxTokens: this.spec.maxTokens ?? null,
        // JSON mode and tool calls do not mix reliably on all providers.
        jsonMode: Boolean(options.schema && !toolSchemas.length),
      });
      promptTokens += llmResponse.promptTokens;
      completionTokens += llmResponse.completionTokens;

      // The model requested tool calls: record them as an assistant turn and
      // append each tool result before the next loop iteration.
      if (llmResponse.toolCalls.length) {
        const assistantCalls = llmResponse.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }));
        messages.push({
          role: 'assistant',
          content: llmResponse.text || '',
          tool_calls: assistantCalls,
        });
        for (const call of llmResponse.toolCalls) {
          const result = await this.tools.execute(call.name, call.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          });
        }
        continue;
      }

      if (!options.schema) {
        return {
          text: llmResponse.text.trim(),
          data: null,
          steps,
          promptTokens,
          completionTokens,
          response: llmResponse,
        };
      }

      try {
        const data = parseJsonObject(llmResponse.text);
        return {
          text: llmResponse.text,
          data,
          steps,
          promptTokens,
          completionTokens,
          response: llmResponse,
        };
      // Retry once if the model returned non-JSON; otherwise surface the error.
      } catch (error) {
        jsonAttempts += 1;
        if (jsonAttempts > 1) {
          throw new AgentError(error instanceof Error ? error.message : String(error));
        }
        messages.push({ role: 'assistant', content: llmResponse.text });
        messages.push({
          role: 'user',
          content:
            'That response was not valid JSON. Return ONLY the JSON object, ' +
            'with no markdown fences or commentary.',
        });
      }
    }

    throw new AgentError(`Agent '${this.spec.name}' exceeded ${limit} steps without a final answer.`);
  }
}

/** Build an {@link Agent} from a markdown agent definition. */
export function agentFromDefinition(
  definition: AgentDefinition,
  llm: LLMClient,
  settings: Settings,
  tools?: ToolRegistry,
): Agent {
  return new Agent(
    {
      name: definition.id,
      role: definition.role,
      systemPrompt: definition.systemPrompt,
      temperature: definition.temperature,
      maxTokens: definition.maxTokens,
    },
    llm,
    settings,
    tools,
  );
}
