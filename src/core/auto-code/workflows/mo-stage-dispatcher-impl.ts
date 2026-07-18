import { z } from 'zod';

import type { BudgetTracker } from '../../concierge/budget.js';
import type { LLMProvider } from '../../concierge/provider.js';
import { runSubMoTask, type SubMoRole } from '../../concierge/sub-mo-template.js';

import type {
  MoStageDispatchInput,
  MoStageDispatchResult,
  MoStageDispatcher,
} from './mo-stage-dispatcher.js';

/**
 * Phase 4.5 — production `MoStageDispatcher` backed by the chat-tier
 * Mo LLM provider. Closes the UX gap left by Phase 4 MVP where every
 * folder selecting a v2 workflow template would silently fall back to
 * `LEGACY_LINEAR_AUTOCODE_DEFINITION` because no real dispatcher was
 * wired (auto-code-factory.ts:warnV2FallbackOnce).
 *
 * Wiring contract:
 *   - `provider` + `model` come from `resolveGatherProvider` /
 *     `resolveGatherModels` (same path mo_get_context uses) — folder-
 *     scoped backend selection + key. Stage's `modelOverride.model`
 *     wins over the workspace default; `useDefault: true` defers to
 *     the resolver. Other override fields (tool / provider / level)
 *     are surfaced but not yet honoured — Phase 4.6 follow-up wires
 *     per-backend routing.
 *   - `budget` is the per-workspace ledger. Each Mo decision charges
 *     through `runSubMoTask` like any other gather sub-call.
 *
 * Failure modes:
 *   - Provider error (rate limit, auth) → `{ok: false, error:
 *     'mo_provider_error'}`.
 *   - JSON parse / schema mismatch on Mo's reply → retried once by
 *     `runSubMoTask`; on second failure → `{ok: false, error:
 *     'mo_decision_unparseable'}`.
 *   - Mo picks a branch not in `stage.branches` → caller (the
 *     WorkflowRunner) handles via `mo_stage_invalid_branch` envelope.
 *     The dispatcher returns the picked branch verbatim; final
 *     validation against `branches` lives in the runner so the audit
 *     trail records exactly what Mo said.
 */

const MoStageDecisionOutput = z.object({
  branch: z.string().min(1),
  reason: z.string().min(1).max(2000),
});
type MoStageDecisionOutput = z.infer<typeof MoStageDecisionOutput>;

const moStageDecisionRole: SubMoRole<MoStageDecisionOutput> = {
  name: 'mo-stage-decision',
  purpose:
    "You are Mo, the workflow orchestrator for the Morion auto-code pipeline. Your job on this turn is to read the ticket context + free-text decision instruction the user wrote into this Mo stage, and pick exactly one of the listed branches that the workflow should follow next. Mo's voice stays neutral and concise — a one-line reason explaining WHY you picked the branch is what the ticket comment + audit log will show the user.",
  schema: MoStageDecisionOutput,
  schemaDescription: `{
  "branch": string,   // EXACTLY one of the legal branches listed in the user message. Case-sensitive. No quotes, no markdown.
  "reason": string    // 1-2 concise sentences (≤500 chars) explaining the decision. MUST include a short verbatim quote ("...") from the evaluated stage output / ticket that drove the pick — no quote, no credibility. NEVER lie about tool outcomes if a stage failed.
}`,
  extraRules: `
DECISION HIERARCHY (strict — order matters):

  1. GROUND TRUTH (highest priority, NEVER violated)
     Your reason MUST be factually consistent with prior stage outputs. Before
     committing to a reason, verify it against the actual stageOutputs JSON:
       * Do not write "diff is non-trivial" unless the prior cli_agent's
         output.summary actually describes file changes / commit hashes /
         line counts. An empty summary or a "QUESTION:"-only summary means
         NO DIFF EXISTS — period.
       * Do not write "the agent fixed X" if the agent only asked questions.
       * Do not invent stage outcomes to justify a branch you want to pick.
     Mo's whole credibility is grounded in never lying about what happened.
     A truthful reason ("no diff produced; user just answered questions →
     looping back to retry") is always better than a polished lie.

  2. GRAPH TOPOLOGY (decides branch when ground truth + situation match)
     The "Legal branches (with destinations)" block exposes the workflow
     topology directly — for each legal branch, you see the destination
     stage id, its kind (cli_agent / mo_stage / human_gate / *_sink), and
     whether it has ALREADY EXECUTED in this run. Branches whose
     destination is marked "already-executed → THIS IS A LOOP-BACK PATH"
     relaunch that prior stage with the current reopenContext threaded
     into its prompt template ({{reopen.reason}} / {{stages.<id>.*}}).

     Concrete topology-driven rules:
       (a) When a "## User just answered your question" block appears AND
           the prior cli_agent stage's output.summary is empty / contains
           only questions / explicitly says no work was done → pick a
           loop-back branch (destination = already-executed cli_agent).
           The user's reply is meant to UNBLOCK that agent for a second
           attempt. Picking "review" instead burns a full review run on
           an empty diff and wastes user time + LLM cost. THIS RULE
           OVERRIDES THE USER'S DECISION INSTRUCTION when the instruction
           is silent about the post-human_gate case (the workflow author
           wired the loop-back edge SPECIFICALLY for this — relying on
           graph topology when the prose is silent is the right call).
       (b) When the prior cli_agent DID produce a real diff → pick a
           FORWARD branch (destination NOT in stageOutputs) per the
           user's instruction (typically "review" or "approve").
       (c) When a prior cli_agent stage explicitly failed (summary says
           so), pick the failure-handling branch the user's instruction
           specifies — never the happy-path forward.
       (d) If no loop-back branch exists in the legal list and the
           situation needs one, the workflow is misconfigured: fall back
           to the user's best forward path and surface the issue in the
           reason ("no loop-back branch wired; routing to <X>").

  3. USER'S DECISION INSTRUCTION (semantic guide, not gospel)
     The user-authored "Decision instruction" describes the SEMANTIC
     intent of each branch in their words. Follow it LITERALLY when it
     covers the case at hand. When it is silent about a case the
     topology + ground truth indicate (rule 2a above), the topology
     wins — workflow authors do NOT have to enumerate every branch in
     prose; they wire edges and trust Mo to read the graph. Do not
     impose your own quality bar (acceptance criteria, scope, etc.)
     unless the instruction explicitly mentions it.

PROCEDURAL RULES:
- Pick exactly ONE branch from the legal list. Picking anything else fails
  the run with mo_stage_invalid_branch — the user will see your raw output
  in the audit trail and lose trust.
- EVIDENCE-CITING: your reason must quote a short verbatim fragment (in
  "quotes") from the direct-predecessor stage output (or the ticket /
  user reply) that justifies the branch. A generalized reason with no
  quote ("fix seems insufficient") is not acceptable — cite the exact
  phrase you are reacting to. You are a router relaying evidence, not a
  narrator writing impressions.
- The reason is what the user sees as the ticket comment after this
  decision. Make it actionable — "review approved the diff" beats "approve"
  alone; "ticket missing acceptance criteria" beats "reject"; "no diff yet,
  looping back with user's answer" beats "re-open".
- The user explicitly dragged this ticket into auto-code; rejecting on a
  hunch wastes their time. Reject only when the instruction or evidence
  makes "reject" clearly correct.
`,
};

export interface ProductionMoStageDispatcherDeps {
  /** Returns the LLM provider Mo should use for this folder, or null
   *  when Mo isn't configured. Mirrors `resolveGatherProvider`'s
   *  contract so the factory wiring is one-liner. */
  resolveProvider: (folderId: string | null) => LLMProvider | null;
  /** Resolves the model id for the given (folder, stage override)
   *  pair. `stageOverride.model` wins when set; otherwise falls back
   *  to the workspace's gather sub-agent model. Returns null when
   *  no usable model resolves (factory soft-fail). */
  resolveModel: (
    folderId: string | null,
    stageOverride: { model?: string } | null,
  ) => string | null;
  budget: BudgetTracker;
}

/**
 * Build a real `MoStageDispatcher` from chat-tier deps. Inject the
 * result into `new WorkflowRunner({ moStageDispatcher: ... })` from
 * the auto-code factory.
 */
export function buildProductionMoStageDispatcher(
  deps: ProductionMoStageDispatcherDeps,
): MoStageDispatcher {
  return {
    async decide(input: MoStageDispatchInput): Promise<MoStageDispatchResult> {
      const folderId = input.folderId || null;
      const provider = deps.resolveProvider(folderId);
      if (!provider) {
        return {
          ok: false,
          error: 'mo_provider_unconfigured',
          message:
            'Mo provider is not configured for this folder. Set OpenRouter / Claude / Groq backend with an API key in Settings → Mo to enable workflow decision stages.',
        };
      }

      // Honour the stage's modelOverride.useDefault discriminator.
      // When useDefault=true the override is a closed shape with no
      // model/provider/tool/level fields — `stageOverride` collapses
      // to null and the resolver returns the workspace default.
      const override = input.stage.modelOverride;
      const modelOverrideInput =
        override && override.useDefault === false
          ? { model: override.model }
          : null;
      const model = deps.resolveModel(folderId, modelOverrideInput);
      if (!model) {
        return {
          ok: false,
          error: 'mo_model_unconfigured',
          message:
            'No model resolved for the active Mo backend. Either set a default model in workspace settings or specify one in the stage modelOverride.',
        };
      }

      // Budget pre-gate. The Mo monthly cap is enforced upstream by
      // user-initiated tools (`mo_ask`, `mo_get_context`)
      // — they refuse BEFORE the LLM call when `withinBudget` is
      // false. A workflow runner driving mo_stage decisions sits in
      // the same lane: without this gate, a budget-exhausted
      // workspace silently kept burning small cents per mo_stage
      // until the next user-tool call surfaced the cap. Mirror the
      // upstream behaviour and refuse cleanly here too so the run
      // fails fast with an actionable envelope.
      const budgetStatus = deps.budget.status();
      if (budgetStatus.withinBudget === false) {
        return {
          ok: false,
          error: 'mo_budget_exceeded',
          message:
            `Mo monthly budget exhausted: $${budgetStatus.spentMonthUsd.toFixed(2)} / $${budgetStatus.monthlyCapUsd}. Workflow paused at \`${input.stage.id}\`. Resets at the start of the next UTC month.`,
        };
      }

      const userScope = buildDecisionScope(input);
      const result = await runSubMoTask(
        {
          provider,
          model,
          budget: deps.budget,
        },
        moStageDecisionRole,
        userScope,
        { folderId, temperature: 0.2 },
      );

      if (!result.ok) {
        // Map sub-Mo failure kinds into the dispatcher envelope.
        // Cost charged on the partial work is still visible upstream
        // via the budget ledger; the runner records costUsd=0 on the
        // stage row because Mo never produced a decision.
        if (result.reason === 'provider_error') {
          return {
            ok: false,
            error: 'mo_provider_error',
            message: result.errorMessage,
          };
        }
        return {
          ok: false,
          error: 'mo_decision_unparseable',
          message:
            `Mo's reply could not be parsed against {branch, reason}: ${
              result.reason
            }${result.errorMessage ? '; ' + result.errorMessage : ''}.${
              result.raw ? ' Raw head: ' + result.raw.slice(0, 200) : ''
            }`,
        };
      }

      return {
        ok: true,
        branch: result.data.branch,
        reason: result.data.reason,
        costUsd: result.costUsd,
      };
    },
  };
}

/** Build the user-scope text the dispatcher sends to Mo. Keeps the
 *  shape stable for prompt-caching benefits across stages of the
 *  same run (Mo provider impls hash the leading prefix). */
function buildDecisionScope(input: MoStageDispatchInput): string {
  const lines: string[] = [];
  lines.push(`# Workflow decision request`);
  lines.push(``);
  lines.push(`Stage id: \`${input.stage.id}\``);
  lines.push(``);
  lines.push(`## Decision instruction (user-authored)`);
  lines.push(input.stage.instruction || '(no extra instruction)');
  lines.push(``);
  // Topology-aware branch listing. For each legal branch, surface:
  //   - the destination stage id
  //   - the destination stage kind (cli_agent / mo_stage / human_gate / *_sink)
  //   - whether that destination has ALREADY executed in this run
  //     (signals a loop-back vs forward path)
  // Without this Mo only sees a flat name list and has to guess
  // intent from branch labels like "re-open" — which fails when
  // the workflow author uses different labels or omits a clue.
  // Test harnesses may omit graphSnapshot — fall back to flat list
  // (preserves the original pre-topology behaviour for those callers).
  const snapshot = input.graphSnapshot;
  const hasGraph =
    !!snapshot && Array.isArray(snapshot.stages) && Array.isArray(snapshot.edges);
  const stagesById = hasGraph
    ? new Map(snapshot.stages.map((s) => [s.id, s]))
    : new Map();
  const edges = hasGraph ? snapshot.edges : [];
  const executedStageIds = new Set(Object.keys(input.stageOutputs));
  lines.push(
    hasGraph ? `## Legal branches (with destinations)` : `## Legal branches`,
  );
  for (const b of input.stage.branches) {
    if (!hasGraph) {
      lines.push(`- \`${b}\``);
      continue;
    }
    const edge = edges.find(
      (e) => e.from === input.stage.id && e.on === b,
    );
    if (!edge) {
      lines.push(`- \`${b}\` → (no edge wired — picking this fails the run)`);
      continue;
    }
    const dest = stagesById.get(edge.to);
    if (!dest) {
      lines.push(`- \`${b}\` → \`${edge.to}\` (destination missing from graph)`);
      continue;
    }
    const tags: string[] = [`kind=${dest.kind}`];
    if (dest.kind === 'cli_agent' && 'agent' in dest && dest.agent) {
      tags.push(`agent=${dest.agent}`);
    }
    if (executedStageIds.has(dest.id)) {
      tags.push(`already-executed → THIS IS A LOOP-BACK PATH`);
    }
    if (dest.kind === 'reject_sink' || dest.kind === 'complete_sink' || dest.kind === 'eject') {
      tags.push(`terminal sink — picking this ends the run`);
    }
    lines.push(`- \`${b}\` → \`${dest.id}\` (${tags.join(', ')})`);
  }
  lines.push(``);
  lines.push(
    `Read each branch's destination above. Loop-back paths (destinations marked "already-executed") relaunch the prior stage with the current reopenContext — pick them when the prior run produced no usable output and you have new input (e.g. user just answered via human_gate). Forward paths advance to a fresh stage — pick them when there's real work to hand off (a diff to review, a result to record).`,
  );
  lines.push(``);
  lines.push(`## Ticket`);
  lines.push(`id: \`${input.ticketId}\``);
  if (input.ticket.title) lines.push(`title: ${input.ticket.title}`);
  if (input.ticket.body) {
    lines.push(`body:`);
    lines.push(truncate(input.ticket.body as string, 4000));
  }
  if (typeof input.ticket.recentComments === 'string' && input.ticket.recentComments.length > 0) {
    lines.push(``);
    lines.push(`## Recent comments`);
    lines.push(input.ticket.recentComments);
  }
  // Cross-run memory ("Mo = router, not narrator"): the previous
  // terminal runs' digest. Critical for mo_start on a re-dragged
  // ticket — the prior reject reason / reviewer verdicts must inform
  // this decision instead of repeating it blind.
  if (
    typeof input.ticket.priorRuns === 'string' &&
    input.ticket.priorRuns.length > 0
  ) {
    lines.push(``);
    lines.push(input.ticket.priorRuns);
  }

  // Prior stage outputs — most relevant for Mo decisions on
  // `mo_after_fix` / `mo_after_review` (they read what the agent
  // produced). "Mo = router, not narrator" (2026-07-14): the
  // DIRECT PREDECESSORS of this
  // decision node (inbound edges — the outputs this decision actually
  // evaluates) get a near-full budget; a 1500-char slice of a
  // reviewer's verdict is how "insufficient fix" mis-rejects happened.
  // Older stages keep the tight cap so long pipelines stay predictable.
  const inboundIds = new Set(
    edges.filter((e) => e.to === input.stage.id).map((e) => e.from),
  );
  const stageEntries = Object.entries(input.stageOutputs);
  if (stageEntries.length > 0) {
    lines.push(``);
    lines.push(`## Prior stage outputs`);
    for (const [stageId, payload] of stageEntries) {
      const cap = inboundIds.has(stageId) ? 12_000 : 1_500;
      lines.push(``);
      lines.push(
        inboundIds.has(stageId)
          ? `### \`${stageId}\` (direct predecessor — the output this decision evaluates)`
          : `### \`${stageId}\``,
      );
      lines.push('```json');
      lines.push(truncate(JSON.stringify(payload.output, null, 2), cap));
      lines.push('```');
    }
  }

  // Reopen-loop context, when applicable.
  const reopenReason =
    typeof input.reopenContext['reason'] === 'string'
      ? (input.reopenContext['reason'] as string)
      : null;
  if (reopenReason) {
    lines.push(``);
    lines.push(`## Reopen context`);
    lines.push(reopenReason);
  }
  // Phase 5 (ticket 01KRFT0742GY480WFJTAW02Z05) — resume from
  // human_gate threads the user's reply through reopenContext so
  // Mo's next decision incorporates it. Without this surface
  // boost the reply lives only in stageOutputs (which Mo sees but
  // may treat as historical context); surfacing it here as a
  // dedicated "user just answered" block makes Mo prefer routing
  // based on the answer.
  const userReply =
    typeof input.reopenContext['userReply'] === 'string'
      ? (input.reopenContext['userReply'] as string)
      : null;
  if (userReply) {
    lines.push(``);
    lines.push(`## User just answered your question`);
    lines.push(userReply);
    lines.push(
      ``,
      `Pick the branch that best reflects the user's answer.`,
    );
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated, ${s.length - max} chars elided)`;
}
