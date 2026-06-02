import { z } from 'zod';

/** Stage discriminator for `WorkflowStageSchema`. L2 only ships
 *  `cli_agent` stages; the other stage kinds are reserved by the
 *  discriminator so older builds reading newer DBs reject cleanly. */
export const StageKindSchema = z.enum([
  'cli_agent',
  'mcp_tool_call',
  'human_gate',
  'branch',
  'mo_router',
  'eject',
  // Spec 01KRAQWPXR5AYTFVF6J12TYHJ1 — Editor Model v2 stage kinds:
  'mo_stage',       // Mo decision node (subsumes mo_router; free-text instruction + per-stage model config).
  'reject_sink',    // Terminal: ticket → backlog + Mo comment with reason. Always present, can't be removed.
  'complete_sink',  // Terminal: ticket → done + Mo comment.   Always present, can't be removed.
]);
export type StageKind = z.infer<typeof StageKindSchema>;
