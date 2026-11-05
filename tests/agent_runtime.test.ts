import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { Agent, Tool, ToolRegistry } from '../src/agents/base';
import { runAgent } from '../src/agents/runner';
import {
  LLMClient,
  LLMResponse,
  parseJsonObject,
  response,
} from '../src/llm/base';
import { makeSettings } from './helpers';

class ScriptedLLM extends LLMClient {
  provider = 'scripted';
  model = 'scripted';
  responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    super();
    this.responses = [...responses];
  }

  async complete(): Promise<LLMResponse> {
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedLLM ran out of responses');
    return next;
  }
}

const Answer = z.object({ ok: z.boolean() });

function agentWith(llm: LLMClient, tools?: ToolRegistry): Agent {
  return new Agent(
    { name: 'tester', role: 'tester', systemPrompt: 'Test.' },
    llm,
    makeSettings(),
    tools,
  );
}

describe('agent runtime', () => {
  it('executes tool calls before answering', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'remember',
        description: 'remember a value',
        parameters: { type: 'object' },
        handler: (args) => {
          calls.push(String(args.value));
          return 'ok';
        },
      },
    ]);
    const llm = new ScriptedLLM([
      response({ toolCalls: [{ id: '1', name: 'remember', arguments: { value: 'hi' } }] }),
      response({ text: '{"ok": true}' }),
    ]);

    const result = await agentWith(llm, registry).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
    expect(calls).toEqual(['hi']);
    expect(result.steps).toBe(2);
  });

  it('retries invalid JSON once', async () => {
    const llm = new ScriptedLLM([response({ text: 'not json' }), response({ text: '{"ok": true}' })]);
    const result = await agentWith(llm).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
  });

  it('reports unknown tools without aborting the run', async () => {
    const registry = new ToolRegistry([
      {
        name: 'known',
        description: 'known',
        parameters: { type: 'object' },
        handler: () => 'ok',
      },
    ]);
    const llm = new ScriptedLLM([
      response({ toolCalls: [{ id: '1', name: 'nope', arguments: {} }] }),
      response({ text: '{"ok": true}' }),
    ]);
    const result = await agentWith(llm, registry).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
  });

  it('persists an audit record for each run', async () => {
    const settings = makeSettings();
    const llm = new ScriptedLLM([response({ text: '{"ok": true}' })]);
    const agent = new Agent(
      { name: 'tester', role: 'tester', systemPrompt: 'Test.' },
      llm,
      settings,
    );
    const workflowId = db.withSession(settings.dbPath, (conn) =>
      db.createWorkflow(conn, 'test', 'test'),
    );
    const result = await runAgent(settings, agent, {
      workflow: 'test',
      role: 'tester',
      task: 'do it',
      schema: Answer,
      workflowRunId: workflowId,
    });
    expect(result.data).toEqual({ ok: true });
    const runs = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, workflowId),
    );
    expect(runs[0].role).toBe('tester');
    expect(runs[0].status).toBe('ok');
    expect(runs[0].workflow).toBe('test');
  });

  it('parses JSON from common model shapes', () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here is the result: {"a": 2}')).toEqual({ a: 2 });
    expect(parseJsonObject('{"a": 3,}')).toEqual({ a: 3 });
    expect(() => parseJsonObject('not json at all')).toThrow();
  });
});

// Referenced so the Tool type stays part of the compiled test surface.
const _tool: Tool | null = null;
void _tool;
