import type { ToolContext } from '../../tools/types.js';
import type { ResolvedWorkflow } from '../../../core/auto-code/workflows/workflow-orchestrator.js';
import {
  DEFAULT_TEMPLATE_ID,
  getWorkflowTemplate,
  resolveWorkflowDefinition,
} from '../../../core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../../../core/auto-code/workflows/workflows-repository.js';
import { isDagWorkflowDefinition } from '../../../core/auto-code/workflows/parse-linear.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../../../core/auto-code/workflows/default-autocode.js';
import { resolveGatherProvider } from '../../features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../../features/concierge-deps/index.js';
import {
  readFolderIntakeInstruction,
  readFolderWorkflowTemplate,
} from '../../features/auto-code-template-settings.js';
import { applyIntakeOverride } from './helpers.js';

/**
 * Resolve an id (built-in template id OR `workflows` row ULID) to a
 * `ResolvedWorkflow` envelope, scoped to the given folder. Returns
 * `null` when the id doesn't match a known template AND isn't owned
 * by the folder — caller decides what to fall back to.
 */
function resolveWorkflowByIdInFolder(
  toolCtx: ToolContext,
  folderId: string,
  id: string,
): ResolvedWorkflow | null {
  if (getWorkflowTemplate(id)) {
    return { definition: resolveWorkflowDefinition(id), workflowId: null };
  }
  const wfRepo = new WorkflowsRepository(toolCtx.db);
  const row = wfRepo.getByIdForFolder(id, folderId);
  if (row) {
    return { definition: row.definition, workflowId: row.id };
  }
  return null;
}

/**
 * Resolve a folder's workflow selection to a `ResolvedWorkflow`
 * envelope (definition + provenance link). Mirrors the routing
 * rule in `wantsWorkflow` so the orchestrator's resolver agrees
 * with the dispatcher's engine choice. Folder-scoped — a stored
 * id pointing at a workflow owned by a DIFFERENT folder falls
 * through to the default (Codex P1b + P1c round 3, 2026-05-10).
 *
 * Per-ticket overrides take precedence: pass `taskId` to consult
 * `notes.workflow_id` first (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE).
 * A stale per-ticket id (workflow row deleted between assignment
 * and admission) falls through to the folder-level resolution —
 * same safety net the folder setting already had.
 */
export function resolveFolderWorkflow(
  toolCtx: ToolContext,
  folderId: string,
  taskId?: string,
): ResolvedWorkflow {
  let resolved: ResolvedWorkflow | null = null;

  // Per-ticket override (when a taskId was supplied). The
  // resolver tolerates a stale id — workflow row deleted, retired
  // template — by falling through to the folder default. We do
  // NOT auto-clear the column here: the resolver runs on the
  // admission hot path and must stay read-only. Auto-clear
  // happens on the DELETE workflow route (route-side sweep).
  if (taskId) {
    const task = toolCtx.notes.getById(taskId);
    if (task?.workflowId) {
      resolved = resolveWorkflowByIdInFolder(toolCtx, folderId, task.workflowId);
    }
  }

  // Fall back to the folder-level pinned setting.
  if (!resolved) {
    const id = readFolderWorkflowTemplate(toolCtx.settings, folderId);
    resolved =
      resolveWorkflowByIdInFolder(toolCtx, folderId, id) ?? {
        definition: resolveWorkflowDefinition(DEFAULT_TEMPLATE_ID),
        workflowId: null,
      };
  }

  // Folder-level intake instruction override (Editor Model v2 spec
  // — user authors a free-text rule that replaces the workflow's
  // hard-coded `mo_start.instruction`. Setting key:
  // `auto_code.intake_instruction.<folderId>`. Empty = use the
  // workflow's own default).
  const intakeOverride = readFolderIntakeInstruction(toolCtx.settings, folderId);
  if (intakeOverride.length > 0) {
    resolved = {
      ...resolved,
      definition: applyIntakeOverride(resolved.definition, intakeOverride),
    };
  }
  // Phase 4.5 (2026-05-11) — the production MoStageDispatcher is
  // wired in the WorkflowRunner constructor above, so v2 (DAG-shape)
  // definitions normally execute as designed.
  //
  // Provider readiness pre-flight: when the resolved definition is v2
  // AND the workspace's Mo provider isn't configured (no API key, or
  // OpenRouter backend not selected), every mo_stage dispatch would
  // fail with `mo_provider_unconfigured` AFTER ensureWorktree has
  // already created a per-run git worktree on disk. That leaves
  // detritus + a confusing user comment. Probe once here and fall
  // back to LEGACY_LINEAR_AUTOCODE_DEFINITION so unconfigured Mo
  // still gets working auto-code through the legacy claude→codex
  // pipeline (no Mo decisions needed). One log per folder per
  // process for observability.
  if (isDagWorkflowDefinition(resolved.definition)) {
    // ConciergeBag must be present for any Mo work — if it isn't
    // wired, fall back immediately.
    if (!toolCtx.concierge) {
      warnV2NoProviderFallbackOnce(folderId, resolved.definition.name);
      return {
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
        workflowId: null,
      };
    }
    const host: ConciergeDepsHost = {
      db: toolCtx.db,
      notes: toolCtx.notes,
      folders: toolCtx.folders,
      comments: toolCtx.comments,
      settings: toolCtx.settings,
      concierge: toolCtx.concierge,
      embeddings: toolCtx.embeddings,
    };
    const moProvider = resolveGatherProvider(host);
    if (!moProvider) {
      warnV2NoProviderFallbackOnce(folderId, resolved.definition.name);
      return {
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
        workflowId: null,
      };
    }
    noteV2DispatchOnce(folderId, resolved.definition.name);
  }
  return resolved;
}

const v2DispatchNotedFolders = new Set<string>();
function noteV2DispatchOnce(folderId: string, templateName: string): void {
  if (v2DispatchNotedFolders.has(folderId)) return;
  v2DispatchNotedFolders.add(folderId);
  console.log(
    `[auto-code] folder ${folderId} dispatching v2 workflow "${templateName}" via the Phase 4.5 production MoStageDispatcher.`,
  );
}

const v2NoProviderWarnedFolders = new Set<string>();
function warnV2NoProviderFallbackOnce(folderId: string, templateName: string): void {
  if (v2NoProviderWarnedFolders.has(folderId)) return;
  v2NoProviderWarnedFolders.add(folderId);
  console.warn(
    `[auto-code] folder ${folderId} selected v2 workflow "${templateName}" but no Mo provider is configured (set OpenRouter/Claude/Groq backend + API key in Settings → Mo). Falling back to legacy linear pipeline for this run.`,
  );
}

/**
 * Diagnostic — what the resolver decides for a folder, surfaced for
 * the UI to detect mismatches (Morion ticket
 * 01KRRXB2K744SKJGAZHW6KET93). Does NOT apply the v2 → legacy Mo
 * fallback gate, which is a per-dispatch concern; this is purely
 * "does the stored value resolve cleanly to what the user picked".
 */
export interface FolderWorkflowResolutionDiagnostic {
  /** Raw value from settings (or `DEFAULT_TEMPLATE_ID` when unset). */
  storedId: string;
  /** Resolution branch the runner took. */
  resolved:
    | { kind: 'template'; templateId: string; displayName: string }
    | { kind: 'row'; rowId: string; displayName: string; templateProvenanceId: string | null }
    | { kind: 'fallback_to_default'; displayName: string };
  /** Why the resolver fell back to the default template, if it did.
   *  null when the stored value resolved cleanly (template OR row). */
  fellBackBecause:
    | null
    | 'unknown_template_id'
    | 'workflow_row_not_found'
    | 'workflow_row_not_owned_by_folder';
}

export function inspectFolderWorkflowResolution(
  toolCtx: ToolContext,
  folderId: string,
): FolderWorkflowResolutionDiagnostic {
  const storedId = readFolderWorkflowTemplate(toolCtx.settings, folderId);
  const template = getWorkflowTemplate(storedId);
  if (template) {
    return {
      storedId,
      resolved: {
        kind: 'template',
        templateId: storedId,
        displayName: template.label,
      },
      fellBackBecause: null,
    };
  }
  const wfRepo = new WorkflowsRepository(toolCtx.db);
  const ownedRow = wfRepo.getByIdForFolder(storedId, folderId);
  if (ownedRow) {
    // Look up the seeded provenance map to surface "this row was
    // seeded from template X" — useful when the row's name has drifted
    // from the canonical template label.
    const provenanceMap = toolCtx.settings.get<Record<string, string>>(
      `auto_code.seeded_row_provenance.${folderId}`,
      {},
    );
    const provenance = provenanceMap?.[ownedRow.id] ?? null;
    return {
      storedId,
      resolved: {
        kind: 'row',
        rowId: ownedRow.id,
        displayName: ownedRow.name,
        templateProvenanceId: provenance,
      },
      fellBackBecause: null,
    };
  }
  // Stored id is neither a known template nor an owned row. Probe
  // whether it's a row owned by a DIFFERENT folder so the UI can
  // distinguish "row deleted" from "wrong folder".
  const anyRow = wfRepo.getById?.(storedId) ?? null;
  const fellBackBecause: FolderWorkflowResolutionDiagnostic['fellBackBecause'] =
    anyRow
      ? 'workflow_row_not_owned_by_folder'
      : looksLikeUlid(storedId)
        ? 'workflow_row_not_found'
        : 'unknown_template_id';
  const defaultTpl = getWorkflowTemplate(DEFAULT_TEMPLATE_ID);
  return {
    storedId,
    resolved: {
      kind: 'fallback_to_default',
      displayName: defaultTpl?.label ?? 'Default',
    },
    fellBackBecause,
  };
}

/** ULIDs are 26 chars Crockford base32. Cheap shape check that
 *  doesn't pull in the ulid lib's parser. */
function looksLikeUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
