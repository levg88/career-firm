/**
 * @file Barrel export for the agents module.
 *
 * Re-exports the firm's agents, agent runtime helpers, prompts, and grounding
 * utilities so callers can import them from a single entry point.
 */

export { OfficeManager } from './office-manager';
export { Headhunter } from './headhunter';
export { ResumeWriter } from './resume-writer';
export { Agent, AgentError, ToolRegistry, toolSchema } from './base';
export type { AgentResult, AgentSpec, Tool } from './base';
export { removeUnsupportedKeywords, validateGrounding } from './grounding';
export { recordHeuristicRun, runAgent } from './runner';
export { HEADHUNTER, OFFICE_MANAGER, RESUME_WRITER } from './prompts';
