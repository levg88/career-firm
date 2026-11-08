/**
 * @file Barrel export for the agents module.
 *
 * Re-exports the firm's agents, the markdown definition loader, the agent
 * runtime helpers, and grounding utilities so callers can import them from a
 * single entry point.
 */

export { OfficeManager } from './office-manager';
export { Headhunter } from './headhunter';
export { ResumeWriter } from './resume-writer';
export { Agent, AgentError, ToolRegistry, agentFromDefinition, toolSchema } from './base';
export type { AgentResult, AgentSpec, Tool } from './base';
export {
  AGENT_SCHEMA_NAMES,
  agentSearchDirs,
  defaultAgentsDir,
  getAgentDefinition,
  loadAgentDefinitions,
  parseAgentFile,
  parseAgentMarkdown,
  renderAgentTask,
  renderTaskTemplate,
} from './definitions';
export type { AgentDefinition, AgentSchemaName, LoadAgentOptions } from './definitions';
export { removeUnsupportedKeywords, validateGrounding } from './grounding';
export { recordHeuristicRun, runAgent } from './runner';
export { schemaForAgent } from './schema';
