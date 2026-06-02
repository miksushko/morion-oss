/**
 * Auto-code Workflow Builder — schemas for L2 (linear pipeline) +
 * forward-compat hooks for L4 (DAG editor).
 *
 * Umbrella:    01KR5F21709BKA6SFHWRFFVVPY
 * Design doc:  01KR5TMKE9GZGXTQ2BCTWCXVD5 §4 (L2)
 *
 * Wire-shape rules:
 *   - `WorkflowDefinitionSchema` is what gets stored in `workflows.definition_json`
 *     AND snapshotted into `workflow_runs.graph_snapshot_json` at run start.
 *     The snapshot is immutable — edits to the parent row never alter in-flight runs.
 *   - L2 only ships `cli_agent` stages; the other stage kinds are reserved by
 *     the discriminator so older builds reading newer DBs reject cleanly.
 *   - Edges are present but unused in v1 (linear pipeline executes the
 *     `stages` array in order). L4 will switch to edge-driven traversal.
 */

export { StageKindSchema, type StageKind } from './stage-kind.js';
export * from './stages/index.js';
export { WorkflowEdgeSchema, type WorkflowEdge } from './edges.js';
export { WorkflowLayoutSchema, type WorkflowLayout } from './layout.js';
export {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from './definition.js';
export {
  type WorkflowRow,
  WorkflowRunStatusSchema,
  type WorkflowRunStatus,
  TERMINAL_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  type WorkflowRunRow,
  WorkflowStageStatusSchema,
  type WorkflowStageStatus,
  TERMINAL_STAGE_STATUSES,
  type WorkflowRunStageRow,
} from './rows.js';
