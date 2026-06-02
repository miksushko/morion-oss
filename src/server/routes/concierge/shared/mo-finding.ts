/**
 * Wire-shape serializer for `MoPatrolFindingsRepository` records.
 * Extracted from `../shared.ts` (2026-05-16, ticket
 * `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

/** Wire-shape for a `MoPatrolFindingsRepository` record on the HTTP
 *  edge. Mirrors `PatrolFindingRecord` but renames `findingKind` to
 *  `kind` for symmetry with the existing risks endpoint. */
export function serializeFinding(f: {
  id: string;
  folderId: string;
  noteId: string | null;
  findingKind: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
  createdAt: number;
  state: string;
  stateChangedAt: number;
  snoozeUntil: number | null;
}): {
  id: string;
  folderId: string;
  noteId: string | null;
  kind: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
  createdAt: number;
  state: string;
  stateChangedAt: number;
  snoozeUntil: number | null;
} {
  return {
    id: f.id,
    folderId: f.folderId,
    noteId: f.noteId,
    kind: f.findingKind,
    severity: f.severity,
    message: f.message,
    context: f.context,
    createdAt: f.createdAt,
    state: f.state,
    stateChangedAt: f.stateChangedAt,
    snoozeUntil: f.snoozeUntil,
  };
}
