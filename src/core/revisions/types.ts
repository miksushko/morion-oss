/**
 * A frozen snapshot of a note at a point in time. Created by the repository
 * before every mutation that would otherwise lose history (manual UI saves
 * on navigate-away, MCP `notes_update` / `notes_append` calls, restore-from-
 * trash). The UI surfaces these via the footer "Edited X" button.
 *
 * `tagIds` stores tag IDs (not names) so a tag rename keeps the historical
 * label correct via lookup. If a tag is deleted between snapshot and restore
 * the missing id is silently dropped — restore is best-effort.
 *
 * `kind` is computed by `listForNote` at read time, not stored: any revision
 * older than the baseline threshold (4h) is a `baseline`, the rest are
 * `recent`. There is at most one `baseline` per note (retention enforces it).
 */
export type RevisionKind = 'recent' | 'baseline';

export interface NoteRevision {
  id: string;
  noteId: string;
  title: string;
  body: string;
  tagIds: string[];
  folderId: string | null;
  actor: string;
  createdAt: number;
  kind: RevisionKind;
}
