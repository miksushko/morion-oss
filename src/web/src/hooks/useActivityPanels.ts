import { useCallback, useState } from 'react';

/**
 * Activity-panel state for the kanban-card modal + the main editor.
 *
 * - `liveRev` bumps on every WS `db.changed` so `ActivityPanel` (no
 *   "refresh collection" entry point — its data is per-note) knows to
 *   refetch. `onLiveSyncTick` is the ref-stable callback wired into
 *   `useLiveSync`. Stability matters: an inline arrow would change
 *   identity on every render, retrigger useLiveSync's useEffect,
 *   close+reopen the WS; on reconnect refetchAll fires → setState →
 *   re-render → effect again. Hit that runaway 2026-04-25 (1000+
 *   /api/notes calls/s during a Mo chat session).
 * - `kanbanActivityCollapsed` defaults open (spec: right sidebar
 *   visible by default on kanban cards).
 * - `editorActivityCollapsed` defaults true (spec: folder notes keep
 *   the writing surface clean, user opens via pane-header toggle).
 */
export function useActivityPanels() {
  const [liveRev, setLiveRev] = useState(0);
  const [kanbanActivityCollapsed, setKanbanActivityCollapsed] = useState(false);
  const [editorActivityCollapsed, setEditorActivityCollapsed] = useState(true);

  const onLiveSyncTick = useCallback(() => {
    setLiveRev((n) => n + 1);
  }, []);

  return {
    liveRev,
    kanbanActivityCollapsed,
    setKanbanActivityCollapsed,
    editorActivityCollapsed,
    setEditorActivityCollapsed,
    onLiveSyncTick,
  };
}
