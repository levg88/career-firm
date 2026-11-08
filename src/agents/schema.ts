/**
 * @file Mapping from markdown `schema:` names to Zod output schemas.
 *
 * Agent definitions stay declarative; the runtime resolves the named schema
 * here so JSON output is still validated and audited.
 */

import type { ZodType } from 'zod';

import { jobAnalysisSchema, parsedCvSchema, tailoredCvSchema } from '../models';
import type { AgentDefinition, AgentSchemaName } from './definitions';

const SCHEMAS: Record<Exclude<AgentSchemaName, 'none'>, ZodType> = {
  parsed_cv: parsedCvSchema,
  job_analysis: jobAnalysisSchema,
  tailored_cv: tailoredCvSchema,
};

/** Resolve the output schema declared by an agent definition. */
export function schemaForAgent(definition: AgentDefinition): ZodType | undefined {
  if (definition.schema === 'none') return undefined;
  return SCHEMAS[definition.schema];
}
