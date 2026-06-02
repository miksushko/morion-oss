-- Per-ticket Auto-code workflow override.
--
-- Ticket:    01KRWQPDKQ2RZMDBJZ5KN0B7YE — "Auto-code: make Coding
--            Workflow selectable, before execution"
-- Umbrella:  01KR5F21709BKA6SFHWRFFVVPY (Auto-code Workflow Builder)
--
-- Adds a per-note workflow pointer. Resolution at admission time:
--   1. `notes.workflow_id` non-null and resolves cleanly
--      (built-in template id OR `workflows` row owned by the same
--      folder) → run that workflow for this ticket.
--   2. Else → fall back to the folder-level resolver
--      (`auto_code.workflow_template.<folderId>` setting → default).
--
-- The column is a TEXT free-form id, NOT a FK, because it can also
-- hold built-in template ids (e.g. `"default"`, `"bug-fix"`) that
-- have no row in `workflows`. Folder-ownership + template-existence
-- are validated by the resolver / patch endpoints.
--
-- Stale references (workflow row deleted, or a built-in id retired)
-- are swept atomically by the DELETE /api/auto-code/workflows/:id
-- route — see `src/server/routes/concierge/auto-code-workflows.ts`.
-- The resolver also tolerates a stale value by falling back to the
-- folder default, so an in-flight orphan never crashes a run.
--
-- Partial index keeps the per-workflow sweep on delete fast even on
-- workspaces with hundreds of thousands of notes; the vast majority
-- have NULL workflow_id so a full-table index would be wasted.

ALTER TABLE notes ADD COLUMN workflow_id TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_workflow_id
  ON notes(workflow_id)
  WHERE workflow_id IS NOT NULL;
