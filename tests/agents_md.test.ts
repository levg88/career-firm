import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getAgentDefinition,
  loadAgentDefinitions,
  parseAgentMarkdown,
  renderAgentTask,
  renderTaskTemplate,
} from '../src/agents/definitions';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-agents-'));
}

const OVERRIDE = `---
id: headhunter
name: Custom Headhunter
role: headhunter
description: A user override.
schema: job_analysis
workflow: tailoring
temperature: 0.7
max_tokens: 512
---

# System Prompt

You are a custom headhunter.

# Task

Review {{job_description}} for {{language}}.
`;

describe('markdown agent definitions', () => {
  it('loads the bundled firm agents from agents/*.md', () => {
    const definitions = loadAgentDefinitions();
    expect(definitions.map((definition) => definition.id).sort()).toEqual([
      'headhunter',
      'office_manager',
      'resume_writer',
    ]);

    const headhunter = getAgentDefinition('headhunter');
    expect(headhunter.name).toBe('Headhunter');
    expect(headhunter.schema).toBe('job_analysis');
    expect(headhunter.workflow).toBe('tailoring');
    expect(headhunter.temperature).toBe(0.1);
    expect(headhunter.maxTokens).toBeNull();
    expect(headhunter.systemPrompt).toContain('elite executive headhunter');
    expect(headhunter.taskTemplate).toContain('{{job_description}}');
  });

  it('renders task placeholders, including JSON values', () => {
    const rendered = renderTaskTemplate('Job: {{ job }}. Data: {{data}}. Missing: {{x}}', {
      job: 'VP Engineering',
      data: { score: 80 },
    });
    expect(rendered).toContain('Job: VP Engineering.');
    expect(rendered).toContain('"score": 80');
    expect(rendered).toContain('{{x}}');
  });

  it('lets a home override replace a bundled definition', () => {
    const directory = tempDir();
    try {
      fs.writeFileSync(path.join(directory, 'headhunter.md'), OVERRIDE);
      const definitions = loadAgentDefinitions({ extraDirs: [directory] });
      const headhunter = definitions.find((definition) => definition.id === 'headhunter');
      expect(headhunter?.name).toBe('Custom Headhunter');
      expect(headhunter?.temperature).toBe(0.7);
      expect(headhunter?.maxTokens).toBe(512);
      expect(headhunter?.systemPrompt).toBe('You are a custom headhunter.');
      expect(headhunter?.sourcePath).toBe(path.join(directory, 'headhunter.md'));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a definition without a system prompt', () => {
    expect(() =>
      parseAgentMarkdown('---\nid: broken\n---\n\n# Task\nDo {{thing}}.', 'broken.md'),
    ).toThrow(/missing a system prompt/);
  });

  it('rejects an unknown output schema', () => {
    expect(() =>
      parseAgentMarkdown(
        '---\nid: broken\nschema: nonsense\n---\n\n# System Prompt\nHi.',
        'broken.md',
      ),
    ).toThrow(/unknown schema/);
  });

  it('fails clearly when a task section is missing', () => {
    const definition = parseAgentMarkdown(
      '---\nid: no_task\n---\n\n# System Prompt\nHi.',
      'no_task.md',
    );
    expect(() => renderAgentTask(definition, {})).toThrow(/missing a "# Task" section/);
  });
});
