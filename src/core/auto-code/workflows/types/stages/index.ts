import { z } from 'zod';
import { CliAgentStageSchema } from './cli-agent.js';
import { McpToolCallStageSchema } from './mcp-tool-call.js';
import { HumanGateStageSchema } from './human-gate.js';
import { BranchStageSchema } from './branch.js';
import { MoRouterStageSchema } from './mo-router.js';
import { EjectStageSchema } from './eject.js';
import { MoStageSchema } from './mo-stage.js';
import { RejectSinkStageSchema, CompleteSinkStageSchema } from './sinks.js';

export const WorkflowStageSchema = z.discriminatedUnion('kind', [
  CliAgentStageSchema,
  McpToolCallStageSchema,
  HumanGateStageSchema,
  BranchStageSchema,
  MoRouterStageSchema,
  EjectStageSchema,
  MoStageSchema,
  RejectSinkStageSchema,
  CompleteSinkStageSchema,
]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export {
  CliAgentNameSchema,
  VerdictPolicySchema,
  CliAgentStageSchema,
  type CliAgentName,
  type VerdictPolicy,
  type CliAgentStage,
} from './cli-agent.js';
export { McpToolCallStageSchema } from './mcp-tool-call.js';
export { HumanGateStageSchema, humanGateGuidance } from './human-gate.js';
export { BranchConditionSchema, BranchStageSchema } from './branch.js';
export { MoRouterStageSchema } from './mo-router.js';
export { EjectStageSchema } from './eject.js';
export { MoModelOverrideSchema, MoStageSchema } from './mo-stage.js';
export { RejectSinkStageSchema, CompleteSinkStageSchema } from './sinks.js';
