import type { EnqueueOutcome as WorkflowEnqueueOutcome } from '../../../core/auto-code/workflows/workflow-orchestrator.js';
import type {
  CliAgentName,
  WorkflowDefinition,
} from '../../../core/auto-code/workflows/types/index.js';
import type { CliAgentAdapter } from '../../../core/auto-code/harness/adapter.js';
import type { UnifiedEnqueueResult } from './types.js';

/**
 * Best-effort cost extraction from an MCP tool's `data` payload.
 * Different tools surface cost under different keys: `costUsd`
 * (mo_ask), `spentUsd` (mo_get_context), `totalCostUsd` (some
 * gather variants). We probe the well-known keys and return the
 * first numeric finite hit, else null. Anything else (deeply
 * nested, unconventional shape) stays a known limitation —
 * documented in the McpToolCallStageSchema's maxBudgetUsd JSDoc.
 */
export function extractCostFromData(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const candidates = ['costUsd', 'spentUsd', 'totalCostUsd'] as const;
  for (const key of candidates) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/**
 * Apply a folder-level intake instruction override to a workflow
 * definition. Returns a shallow clone with `mo_start.instruction`
 * replaced (when an mo_start stage exists) or — for legacy linear
 * workflows lacking a Mo gate — the definition untouched.
 *
 * Never mutates the input definition: registry templates are shared
 * across folders, mutating in place would leak one folder's override
 * to every other folder reading from the same registry slot.
 */
export function applyIntakeOverride(
  def: WorkflowDefinition,
  override: string,
): WorkflowDefinition {
  const startStage = def.stages.find(
    (s) => s.kind === 'mo_stage' && s.isStart === true,
  );
  if (!startStage) return def;
  return {
    ...def,
    stages: def.stages.map((s) =>
      s.id === startStage.id ? { ...s, instruction: override } : s,
    ),
  };
}

/**
 * Synthetic adapter returned by `buildWorkflowOrchestrator` when a
 * preflight check determined the underlying CLI is unavailable. The
 * adapter throws `AgentBinaryNotFoundError` from spawn() — same shape
 * the real adapter would throw at runtime, but determined at factory
 * time so the runner's fallback-on-recoverable-error path activates
 * immediately instead of after a real spawn failure (which would race
 * the `recoverable` flag interpretation).
 */
export function makeMissingBinaryAdapter(
  agent: CliAgentName,
  detail: string,
): CliAgentAdapter {
  return {
    name: agent,
    async spawn(): Promise<never> {
      const { AgentBinaryNotFoundError } = await import(
        '../../../core/auto-code/harness/adapter.js'
      );
      throw new AgentBinaryNotFoundError(agent, [detail]);
    },
  };
}

export function collapseWorkflowResult(
  out: WorkflowEnqueueOutcome,
): UnifiedEnqueueResult {
  if (out.kind === 'enqueued') {
    return {
      kind: 'enqueued',
      runId: out.runId,
      deduped: out.deduped,
    };
  }
  return {
    kind: 'rejected',
    reason: out.reason,
    missingDetails: out.missingDetails,
  };
}
