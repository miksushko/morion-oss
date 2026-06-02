import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

import {
  parseLinearWorkflow,
  parseDraftWorkflow,
  isDraftWorkflowDefinition,
} from './parse-linear.js';
import { listWorkflowTemplates, DEFAULT_TEMPLATE_ID } from './templates.js';
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRow,
} from './types/index.js';

/**
 * Auto-code Workflow Builder Этап 2 — CRUD for the `workflows` table
 * (migration 0028).
 *
 * Stores per-folder user-defined workflow definitions. The runtime
 * `WorkflowOrchestrator` consumes these through the resolver
 * injection wired in `auto-code-factory.ts` — registry-shipped
 * templates win when the per-folder setting names a built-in id;
 * otherwise the resolver falls through to this repo and looks up
 * the row whose primary key matches.
 *
 * Out of scope (future):
 *   - Versioning / revisions. Edits overwrite in place; in-flight
 *     runs use the immutable `graph_snapshot_json` so the new shape
 *     never reaches a running adapter.
 *   - Workflow cloning between folders. The L4 editor will surface
 *     a copy-to-folder button; the underlying repo just inserts a
 *     fresh row with a new ULID.
 *
 * Validation is layered: the repo enforces structural shape via
 * `WorkflowDefinitionSchema` AND the L2 linear-only constraint via
 * `parseLinearWorkflow`. A future L4 editor will skip the linear
 * gate by calling `WorkflowDefinitionSchema.parse` directly.
 */

interface WorkflowDbRow {
  id: string;
  folder_id: string;
  name: string;
  definition_json: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

function rowTo(row: WorkflowDbRow): WorkflowRow {
  // Re-validate on read so a corrupted row (manual SQL edit, schema
  // drift) surfaces a clear error rather than silently feeding bad
  // shape into the runner.
  const def = WorkflowDefinitionSchema.parse(JSON.parse(row.definition_json));
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    definition: def,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateWorkflowInput {
  folderId: string;
  name: string;
  definition: WorkflowDefinition;
  /** When true, mark this workflow as the folder's default. The
   *  repo clears any prior default-row in the same folder
   *  atomically. */
  isDefault?: boolean;
}

export interface UpdateWorkflowInput {
  name?: string;
  definition?: WorkflowDefinition;
  isDefault?: boolean;
}

/** Slim row used by sidebar / list rendering. Skips the parsed
 *  `definition` field; downstream callers fetch it via `getById`
 *  when they actually need to render the canvas. */
export interface WorkflowSummary {
  id: string;
  folderId: string;
  name: string;
  isDefault: boolean;
  stageCount: number;
  agentChain: readonly string[];
  /** True when the definition contains v2 stage kinds (`mo_stage` /
   *  `reject_sink` / `complete_sink` / `mo_router` / `eject` /
   *  `human_gate`) that the L2 linear runner can't dispatch. UI uses
   *  this to swap the "active" badge for a "preview" treatment so
   *  the user knows their edits won't reach a real run until the
   *  Phase 4 DAG runner ships (Codex P1 round 4, 2026-05-11). */
  isDraft: boolean;
  createdAt: number;
  updatedAt: number;
}

export class WorkflowsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Insert a fresh workflow row.
   *
   *  Save-path validation auto-selects between strict and draft:
   *    - Pure cli_agent / mcp_tool_call definitions are validated via
   *      `parseLinearWorkflow` (strict L2 — also runnable today).
   *    - Definitions containing any v2 stage kind (`mo_stage` /
   *      `reject_sink` / `complete_sink` plus their deprecated aliases
   *      `mo_router` / `eject`, plus `human_gate` / `branch`) take the
   *      `parseDraftWorkflow` path — the full Zod schema with v2
   *      invariants but without the linear-only edge-chain gate.
   *      These rows are persisted but NOT runnable until the Phase 4
   *      DAG runner ships; the runner's `parseLinearWorkflow` call on
   *      dispatch surfaces a clean "kind reserved for L3/L4" error.
   *
   *  Throws on invalid definition. Returns the inserted row with
   *  parsed definition. */
  create(input: CreateWorkflowInput): WorkflowRow {
    const def = isDraftWorkflowDefinition(input.definition)
      ? parseDraftWorkflow(input.definition)
      : parseLinearWorkflow(input.definition);
    const id = ulid();
    const now = this.now();
    const tx = this.db.transaction(() => {
      if (input.isDefault) {
        this.db
          .prepare(
            `UPDATE workflows SET is_default = 0, updated_at = ?
             WHERE folder_id = ? AND is_default = 1`,
          )
          .run(now, input.folderId);
      }
      this.db
        .prepare(
          `INSERT INTO workflows (id, folder_id, name, definition_json,
                                  is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.folderId,
          input.name,
          JSON.stringify(def),
          input.isDefault ? 1 : 0,
          now,
          now,
        );
    });
    tx();
    return this.getById(id)!;
  }

  /** Look up by primary key. Returns null when not found OR when
   *  the row's stored definition fails re-validation (treated as
   *  missing rather than crashing the caller).
   *
   *  WARNING: this method does NOT check folder ownership. A
   *  caller that wants per-folder isolation (orchestrator's
   *  resolver, settings PUT validator) MUST use
   *  `getByIdForFolder` instead — without that gate, folder A
   *  could accidentally run a workflow definition owned by
   *  folder B (Codex P1b round 3, 2026-05-10). */
  getById(id: string): WorkflowRow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflows WHERE id = ?`)
      .get(id) as WorkflowDbRow | undefined;
    if (!row) return null;
    try {
      return rowTo(row);
    } catch {
      return null;
    }
  }

  /** Folder-scoped lookup. Returns the row only when the workflow
   *  exists AND is owned by the supplied folder. Use this on every
   *  cross-folder boundary (resolver, settings validator) so a
   *  user pointing folder A at workflow B (owned by folder B)
   *  surfaces as "not found" instead of silently running B's
   *  definition. */
  getByIdForFolder(id: string, folderId: string): WorkflowRow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflows WHERE id = ? AND folder_id = ?`)
      .get(id, folderId) as WorkflowDbRow | undefined;
    if (!row) return null;
    try {
      return rowTo(row);
    } catch {
      return null;
    }
  }

  /** Every workflow in the folder ordered by default-first then
   *  name ASC, matching the index on `(folder_id, is_default DESC,
   *  name)`. FULL parse — used by callers that need the
   *  WorkflowDefinition (resolver). For list-views use
   *  `listSummariesForFolder` which avoids the per-row Zod walk. */
  listForFolder(folderId: string): readonly WorkflowRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflows
         WHERE folder_id = ?
         ORDER BY is_default DESC, name ASC`,
      )
      .all(folderId) as WorkflowDbRow[];
    const out: WorkflowRow[] = [];
    for (const r of rows) {
      try {
        out.push(rowTo(r));
      } catch {
        // Skip malformed rows; the repository never crashes the
        // list endpoint over a single bad row.
      }
    }
    return out;
  }

  /**
   * Slim per-folder list for sidebar / dropdown rendering. Skips
   * the full `WorkflowDefinitionSchema.parse` per row — the list
   * surface only needs id/name/isDefault/timestamps + a pre-
   * computed `stageCount` and `agentChain` for the agent-chip UI.
   *
   * Reading those two from JSON without Zod-parsing the whole
   * definition is dramatically faster on folders with many
   * workflows (each definition can be tens of KB of prompt text).
   * Earlier ad-hoc render through `listForFolder().map(...)` walked
   * the entire schema on every popup open — visibly slow to the
   * user.
   */
  listSummariesForFolder(folderId: string): readonly WorkflowSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, folder_id, name, definition_json, is_default,
                created_at, updated_at
         FROM workflows
         WHERE folder_id = ?
         ORDER BY is_default DESC, name ASC`,
      )
      .all(folderId) as WorkflowDbRow[];
    const DRAFT_KINDS = new Set([
      'mo_stage',
      'reject_sink',
      'complete_sink',
      'mo_router',
      'eject',
      'human_gate',
    ]);
    const out: WorkflowSummary[] = [];
    for (const r of rows) {
      let stageCount = 0;
      const agentChain: string[] = [];
      let isDraft = false;
      try {
        const raw = JSON.parse(r.definition_json) as {
          stages?: Array<{ kind?: string; agent?: string }>;
        };
        const stages = Array.isArray(raw.stages) ? raw.stages : [];
        stageCount = stages.length;
        for (const s of stages) {
          if (s && s.kind === 'cli_agent' && typeof s.agent === 'string') {
            agentChain.push(s.agent);
          }
          if (s && typeof s.kind === 'string' && DRAFT_KINDS.has(s.kind)) {
            isDraft = true;
          }
        }
      } catch {
        // Malformed JSON — surface the row with zeros so the user
        // can still see + delete it from the sidebar.
      }
      out.push({
        id: r.id,
        folderId: r.folder_id,
        name: r.name,
        isDefault: r.is_default === 1,
        stageCount,
        agentChain,
        isDraft,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
    return out;
  }

  /** Patch any subset of the editable fields. Returns the updated
   *  row, or null when the id wasn't found. Definition is
   *  re-validated when present. Throws on validation failure. */
  update(id: string, patch: UpdateWorkflowInput): WorkflowRow | null {
    const existing = this.getById(id);
    if (!existing) return null;

    let validatedDef: WorkflowDefinition | undefined;
    if (patch.definition !== undefined) {
      // Same auto-select as create(): v2-draft definitions skip the
      // linear-only gate so the editor can save mo_stage / sink graphs
      // before Phase 4 ships the DAG runner.
      validatedDef = isDraftWorkflowDefinition(patch.definition)
        ? parseDraftWorkflow(patch.definition)
        : parseLinearWorkflow(patch.definition);
    }

    const now = this.now();
    const tx = this.db.transaction(() => {
      if (patch.isDefault === true && !existing.isDefault) {
        // Atomic switch — clear any prior default row in the folder
        // before flipping us on.
        this.db
          .prepare(
            `UPDATE workflows SET is_default = 0, updated_at = ?
             WHERE folder_id = ? AND is_default = 1 AND id != ?`,
          )
          .run(now, existing.folderId, id);
      }
      const sets: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        values.push(patch.name);
      }
      if (validatedDef !== undefined) {
        sets.push('definition_json = ?');
        values.push(JSON.stringify(validatedDef));
      }
      if (patch.isDefault !== undefined) {
        sets.push('is_default = ?');
        values.push(patch.isDefault ? 1 : 0);
      }
      values.push(id);
      this.db
        .prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values);
    });
    tx();
    return this.getById(id);
  }

  /** Delete by primary key. Returns true when a row was deleted,
   *  false when the id wasn't found. In-flight `workflow_runs` rows
   *  are NOT cascade-deleted (the snapshot graph keeps them
   *  runnable); callers that want to cancel-and-delete should call
   *  `runner.cancel` on each active run for this workflow first. */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Seed the registry-shipped templates as editable workflow
   * rows. Intent (spec §J38 + §G27): every workflow is editable;
   * templates are seed material, not a separate read-only
   * category.
   *
   * Per-template seeding: any registry template whose id isn't
   * already in the `seedTracker` (user-deleted) AND whose label
   * isn't already present in the folder gets inserted.
   *
   * Returns `{ inserted, defaultRowId }` — `defaultRowId` is the
   * ULID of the row that landed with `is_default=1` (either
   * just inserted OR an existing row already marked default).
   * Caller uses it to migrate the per-folder
   * `auto_code.workflow_template` setting from a legacy registry
   * id ('default') to the seeded ULID, so the resolver picks
   * the editable row instead of the frozen registry definition
   * (Codex P1a round 6, 2026-05-10).
   *
   * Sticky-delete tracking is provenance-keyed (rowId →
   * templateId) so a user renaming a custom workflow to a
   * shipped template's label can't accidentally suppress the
   * shipped one (Codex P2a). The caller threads a
   * `recordProvenance(rowId, templateId)` writer to persist
   * the mapping in workspace settings.
   */
  seedDefaultsForFolder(
    folderId: string,
    seedTracker?: {
      isSeeded(id: string): boolean;
      markSeeded(id: string): void;
      recordProvenance?(rowId: string, templateId: string): void;
    },
  ): { inserted: number; defaultRowId: string | null } {
    const existingRows = this.db
      .prepare(`SELECT id, name, is_default FROM workflows WHERE folder_id = ?`)
      .all(folderId) as Array<{
      id: string;
      name: string;
      is_default: number;
    }>;
    const existingNames = new Set(existingRows.map((r) => r.name));
    const existingDefault = existingRows.find((r) => r.is_default === 1);

    const templates = listWorkflowTemplates();
    let inserted = 0;
    let defaultRowId: string | null = existingDefault?.id ?? null;
    const tx = this.db.transaction(() => {
      const now = Date.now();
      for (const tpl of templates) {
        if (existingNames.has(tpl.label)) continue;
        if (seedTracker?.isSeeded(tpl.id)) continue;
        try {
          // Templates are v2 drafts (mo_stage / reject_sink /
          // complete_sink) under the Editor Model v2 spec
          // (01KRAQWPXR5AYTFVF6J12TYHJ1). Validate via
          // parseDraftWorkflow — parseLinearWorkflow would throw
          // LinearWorkflowError on the v2 kinds, silently skipping
          // every template via the catch below.
          const def = parseDraftWorkflow(tpl.definition);
          // Only mark this seeded row as default when the
          // template IS the registry default AND the folder
          // doesn't already have its own default row. Otherwise
          // leave it non-default; the user's existing pick stays.
          const shouldMarkDefault =
            tpl.id === DEFAULT_TEMPLATE_ID && defaultRowId === null;
          const newRowId = ulid();
          this.db
            .prepare(
              `INSERT INTO workflows (id, folder_id, name, definition_json,
                                      is_default, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              newRowId,
              folderId,
              tpl.label,
              JSON.stringify(def),
              shouldMarkDefault ? 1 : 0,
              now,
              now,
            );
          if (shouldMarkDefault) defaultRowId = newRowId;
          seedTracker?.markSeeded(tpl.id);
          seedTracker?.recordProvenance?.(newRowId, tpl.id);
          inserted += 1;
        } catch {
          // Skip a template whose shipped definition fails the
          // linear-only refinement — better to land six than zero.
        }
      }
    });
    tx();
    return { inserted, defaultRowId };
  }
}
