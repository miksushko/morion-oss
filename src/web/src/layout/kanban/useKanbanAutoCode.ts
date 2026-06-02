import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutoCodeQueueRow, Note } from '../../lib/api';
import { api } from '../../lib/api';

/**
 * One batch fetch per render of all visible card ids so a 50-card kanban
 * doesn't translate to 50 HTTP requests. Re-polls every 4s while the view
 * is mounted so active runs animate state changes (`fix_running` →
 * `review_running` → `done`) without a manual refresh, AND on every
 * notes-set change so a fresh card created mid-session also gets its
 * badge picked up.
 *
 * `noteIdsKey` is the join of all visible ids — we re-fetch when the SET
 * of cards changes, but a re-render that didn't add/remove a card (e.g.
 * drag-reorder within a column) doesn't trigger a fetch (kept stable by
 * the join string).
 */
export function useKanbanAutoCode(notes: Note[]) {
  const noteIdsKey = useMemo(() => notes.map((n) => n.id).join(','), [notes]);
  const [autoCodeRows, setAutoCodeRows] = useState<Map<string, AutoCodeQueueRow>>(
    () => new Map(),
  );

  useEffect(() => {
    if (notes.length === 0) {
      setAutoCodeRows(new Map());
      return;
    }
    let cancelled = false;
    const taskIds = notes.map((n) => n.id);
    const load = async () => {
      try {
        const { rowsByTask } = await api.getAutoCodeRunsBatch(taskIds);
        if (cancelled) return;
        const next = new Map<string, AutoCodeQueueRow>();
        for (const [taskId, row] of Object.entries(rowsByTask)) {
          if (row) next.set(taskId, row);
        }
        setAutoCodeRows(next);
      } catch {
        // 402 (not Pro) / 5xx — drop badges silently. Folders without
        // auto-code shouldn't surface the upsell here.
        if (!cancelled) setAutoCodeRows(new Map());
      }
    };
    void load();
    const poll = setInterval(load, 4_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteIdsKey]);

  const [autoCodeDrawerTaskId, setAutoCodeDrawerTaskId] = useState<string | null>(null);
  // Ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE — the badge now opens the
  // drawer by taskId (not row), so tickets WITHOUT a run can still
  // surface a "configure" affordance.
  const handleOpenAutoCode = useCallback((taskId: string) => {
    setAutoCodeDrawerTaskId(taskId);
  }, []);
  const closeAutoCodeDrawer = useCallback(() => setAutoCodeDrawerTaskId(null), []);

  const autoCodeDrawerNote = useMemo(
    () => (autoCodeDrawerTaskId ? notes.find((n) => n.id === autoCodeDrawerTaskId) : null),
    [autoCodeDrawerTaskId, notes],
  );

  return {
    autoCodeRows,
    autoCodeDrawerTaskId,
    autoCodeDrawerNote,
    handleOpenAutoCode,
    closeAutoCodeDrawer,
  };
}
