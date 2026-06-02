import type { TicketContext } from './runner.js';
import type {
  MoStageSchema,
  WorkflowDefinition,
  WorkflowStage,
} from './types/index.js';
import type { z } from 'zod';

/**
 * Auto-code Workflow Builder Phase 4 — `MoStageDispatcher` contract.
 *
 * A `mo_stage` is the Mo decision node from the Editor Model v2 spec
 * (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1). At runtime Mo reads the
 * stage's `instruction` + ticket context + prior stage outputs, picks
 * one of `stage.branches`, and the DAG runner advances along the
 * outbound edge whose `on` matches the picked branch.
 *
 * The dispatcher is injected into `WorkflowRunner` via deps. The
 * default (`DEFAULT_MO_STAGE_DISPATCHER`) refuses every call with a
 * clear error envelope so a runner wired without Mo backend fails
 * loudly rather than picking a random branch.
 *
 * Production wiring lives in `auto-code-factory.ts` (Phase 4 sibling)
 * which constructs a real dispatcher backed by the workspace's
 * configured Mo provider (OpenRouter / Groq / Claude direct / etc.).
 * Tests inject deterministic stubs that return a chosen branch.
 */

type MoStage = z.infer<typeof MoStageSchema>;

export interface MoStageDispatchInput {
  readonly runId: string;
  readonly folderId: string;
  readonly ticketId: string;
  readonly stage: MoStage;
  readonly ticket: TicketContext;
  /** Snapshot of prior stage outputs keyed by stage id. Same shape
   *  the runner threads through Mustache rendering. */
  readonly stageOutputs: Readonly<Record<string, { output: Record<string, unknown> }>>;
  /** Reopen context from any prior verdict-policy routing — empty
   *  on the v2 happy path; surfaces the prior reviewer reason when
   *  Mo is asked again after a reopen loop. */
  readonly reopenContext: Readonly<Record<string, unknown>>;
  /** Absolute path of the run's worktree. Adapters that read the
   *  filesystem (e.g. Mo running `mo_get_context` over the worktree)
   *  need this; pure-LLM dispatchers ignore. */
  readonly worktreePath: string;
  /** Frozen workflow graph (stages + edges) for THIS run. Mo reads
   *  the topology to understand where each branch leads — without
   *  this the dispatcher only sees a flat branch-name list and has
   *  to pattern-match on names like "re-open" / "retry" / etc.
   *  With the graph it can reason: "branch X targets a cli_agent
   *  stage that already ran → this is a loop-back path", which
   *  closes the post-human_gate routing hole where Mo would default
   *  to a forward branch even when a loop-back was wired.
   *  Optional for back-compat with stub callers; production runner
   *  always populates from `run.graphSnapshot`. */
  readonly graphSnapshot?: WorkflowDefinition;
}

export type MoStageDispatchResult =
  | {
      readonly ok: true;
      readonly branch: string;
      /** Free-text reason Mo gave for picking the branch. Surfaced
       *  in the ticket comment when `stage.postComment` is true. */
      readonly reason: string;
      /** Reported USD cost for this Mo call. Optional — when the
       *  provider returns 0 / null the runner records 0. Folded
       *  into `workflow_runs.total_cost_usd` like any other stage. */
      readonly costUsd?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
    };

export interface MoStageDispatcher {
  decide(input: MoStageDispatchInput): Promise<MoStageDispatchResult>;
}

/**
 * Default — refuses every call. Production factory wires the real
 * impl; tests inject deterministic stubs. Failing here is preferable
 * to silently picking the first branch (would mask broken wiring on
 * every dogfood run).
 */
export const DEFAULT_MO_STAGE_DISPATCHER: MoStageDispatcher = {
  async decide() {
    return {
      ok: false,
      error: 'mo_stage_dispatcher_not_wired',
      message:
        'No MoStageDispatcher injected on this WorkflowRunner. Wire one via factory or test setup before dispatching mo_stage decisions.',
    };
  },
};

/** Type-guard utility — distinguishes mo_stage from other stages. */
export function isMoStage(stage: WorkflowStage): stage is MoStage {
  return stage.kind === 'mo_stage';
}
