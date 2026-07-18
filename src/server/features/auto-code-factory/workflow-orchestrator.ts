import type { ToolContext } from '../../tools/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  detectAgentAvailability,
  runPreflight,
} from '../../../core/auto-code/preflight.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import { WorkflowRunner } from '../../../core/auto-code/workflows/runner.js';
import { getOrCreateWorkflowRunner } from './runner-singleton.js';
import { WorkflowOrchestrator } from '../../../core/auto-code/workflows/workflow-orchestrator.js';
import { buildProductionMoStageDispatcher } from '../../../core/auto-code/workflows/mo-stage-dispatcher-impl.js';
import { buildProductionMoMessengerDispatcher } from '../../../core/auto-code/workflows/mo-messenger-dispatcher.js';
import {
  resolveGatherProvider,
  resolveGatherModels,
} from '../../features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../../features/concierge-deps/index.js';
import { resolveFolderWorkflow } from './folder-workflow-resolver.js';
import { buildAdapterFactory } from './cli-agent-adapter-factory.js';
import { buildMcpToolDispatcher } from './mcp-tool-dispatcher.js';
import { buildHumanGateHandler } from './human-gate-handler.js';
import { buildAutoMergeHook } from './auto-merge-hook.js';

/**
 * Per-request factory for the new `WorkflowOrchestrator` (umbrella
 * `01KR5F21709BKA6SFHWRFFVVPY`, L2.T7.B). Same `null`-on-unavailable
 * contract as `buildAutoCodeOrchestrator`. The L1 harness adapters
 * resolve their own binaries; we only check Claude readiness here
 * (legacy preflight contract; workflow runner doesn't directly need
 * the binary path — adapters resolve their own).
 */
export async function buildWorkflowOrchestrator(
  toolCtx: ToolContext,
): Promise<WorkflowOrchestrator | null> {
  if (!toolCtx.concierge) return null;
  const folderSettings = toolCtx.concierge.folderSettings;
  if (!folderSettings) return null;
  const pf = runPreflight();
  if (!pf.claude.ready || !pf.claude.path) return null;

  const runsRepo = new WorkflowRunsRepository(toolCtx.db);
  const adapterFactory = buildAdapterFactory(toolCtx, pf);

  // Per-run JSONL transcripts under `~/.morion/runs/`. The harness
  // adapters write `<transcriptDir>/<sessionId>.jsonl`; the L2 UI
  // drawer (T7.C) reads from the same path via the runs repo's
  // `transcript_path` snapshot.
  const transcriptDir = join(homedir(), '.morion', 'runs');

  // Build the host once so the MoStageDispatcher captures it via
  // closure. The dispatcher resolves the provider + model per call
  // (settings can change between dispatches; folder-scoped backend
  // selection respects that).
  const host: ConciergeDepsHost = {
    db: toolCtx.db,
    notes: toolCtx.notes,
    folders: toolCtx.folders,
    comments: toolCtx.comments,
    settings: toolCtx.settings,
    concierge: toolCtx.concierge,
    embeddings: toolCtx.embeddings,
  };
  const moStageDispatcher = toolCtx.concierge?.budget
    ? buildProductionMoStageDispatcher({
        resolveProvider: () => {
          const moProvider = resolveGatherProvider(host);
          return moProvider?.provider ?? null;
        },
        resolveModel: (_folderId, stageOverride) => {
          if (stageOverride?.model) return stageOverride.model;
          const models = resolveGatherModels(host);
          return models?.subagentModel ?? null;
        },
        budget: toolCtx.concierge.budget,
      })
    : undefined;

  // Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA) — Mo as
  // conversational lead. Composes the chat opening message when a
  // human_gate fires (replacing the legacy static `stage.prompt`)
  // AND produces short Mo-curated summaries for each cli_agent
  // stage close (replacing the prior verbatim 📝 dump).
  const moMessengerDispatcher = toolCtx.concierge?.budget
    ? buildProductionMoMessengerDispatcher({
        resolveProvider: () => {
          const moProvider = resolveGatherProvider(host);
          return moProvider?.provider ?? null;
        },
        resolveModel: () => {
          const models = resolveGatherModels(host);
          return models?.subagentModel ?? null;
        },
        budget: toolCtx.concierge.budget,
      })
    : null;

  // Process-singleton per DB — a cancel from ANY later request must reach
  // the live run's adapter handle, which lives in this runner's in-memory
  // `states` map. See runner-singleton.ts.
  // On a cache hit the freshly-built deps below are discarded; they are
  // cheap, side-effect-free closures that resolve provider/model/binaries
  // live per call anyway, so the cached runner's originals stay correct.
  const runner = getOrCreateWorkflowRunner(toolCtx.db, () => new WorkflowRunner({
    repo: runsRepo,
    adapterFactory,
    transcriptDir,
    // Этап 4 — wire `mcp_tool_call` stages through the existing
    // chat-tier MCP dispatcher so workflows can compose Mo / MCP
    // tools (mo_ask, notes_search, etc.) alongside cli_agent
    // stages.
    mcpToolDispatcher: buildMcpToolDispatcher(toolCtx),
    // Phase 4.5 — production MoStageDispatcher. When the workspace
    // has Mo configured (budget tracker present + provider settings
    // valid), the runner uses real chat-tier LLM calls to pick
    // branches on `mo_stage` nodes. Without it the runner falls back
    // to DEFAULT_MO_STAGE_DISPATCHER which fails clean with
    // `mo_stage_dispatcher_not_wired` — caught upstream and routed
    // back through `resolveFolderWorkflow`'s v2→legacy fallback.
    moStageDispatcher,
    // Phase 5 MVP (ticket 01KRFT0742GY480WFJTAW02Z05) — production
    // human_gate handler.
    humanGateHandler: buildHumanGateHandler({
      toolCtx,
      runsRepo,
      moMessengerDispatcher,
    }),
  }));

  return new WorkflowOrchestrator({
    db: toolCtx.db,
    notes: toolCtx.notes,
    folders: toolCtx.folders,
    comments: toolCtx.comments,
    audit: toolCtx.audit,
    folderSettings,
    runsRepo,
    runner,
    // Phase 6 V2 — Mo composes the short stage-end comment instead
    // of the orchestrator posting the agent's verbatim multi-kb
    // summary. Null when Mo isn't configured (budget exhausted /
    // no provider key) — orchestrator falls back to the truncated
    // verbatim post.
    moMessenger: moMessengerDispatcher,
    // Optional escalation surface — when wired, an
    // `escalated_by_review` terminal opens a real Ask Mo chat
    // session instead of a comment-only signal.
    sessions: toolCtx.concierge.sessions,
    messages: toolCtx.concierge.messages,
    // Per-folder workflow selection. Reads
    // `auto_code.workflow_template.<folderId>` from workspace KV
    // and resolves in this order:
    //
    //   1. Built-in registry (`default`, `pi-fix`, `claude-solo`)
    //      → workflowId=null.
    //   2. `workflows` table row OWNED BY THIS FOLDER (Этап 2 —
    //      user-defined custom workflows) → workflowId=<row.id>.
    //   3. Fallback to DEFAULT_AUTOCODE_DEFINITION when the stored
    //      id matches neither (stale id from a deleted row OR a
    //      cross-folder reference) → workflowId=null.
    //
    // The fallback path keeps a folder runnable even after a user
    // deletes the custom workflow it was pointing at — the next
    // enqueue uses the default template instead of crashing the
    // run with a missing-definition error. Cross-folder references
    // (folder A pointing at folder B's workflow) also fall back —
    // see `getByIdForFolder` ownership check (Codex P1b round 3).
    //
    // Per-ticket override (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE) —
    // `notes.workflow_id` takes precedence over the folder setting.
    // Forwarded as the optional `taskId` arg; resolver consults the
    // note first, then falls through to the folder default when the
    // per-ticket id is null OR stale.
    resolveDefinition: (folderId, taskId) =>
      resolveFolderWorkflow(toolCtx, folderId, taskId),
    // Required-agents preflight (Codex P2). Probes binaries fresh
    // per call so a `brew install pi` mid-session works without
    // restarting the sidecar.
    isAgentAvailable: (agent) => {
      const avail = detectAgentAvailability();
      switch (agent) {
        case 'claude':
          return avail.claude.ready;
        case 'codex':
          return avail.codex.ready;
        case 'pi':
          return avail.pi.ready;
        case 'opencode':
          return avail.opencode.ready;
        default:
          return false;
      }
    },
    // Auto-merge hook — honor the per-folder
    // `auto_code.auto_merge.<folderId>` setting. When on, fires
    // `mergeWorktreeIntoTarget` right after the run flips to done
    // and posts the "✓ Auto-merged into <target>" footprint.
    autoMergeAfterDone: buildAutoMergeHook({ toolCtx, runsRepo }),
  });
}
