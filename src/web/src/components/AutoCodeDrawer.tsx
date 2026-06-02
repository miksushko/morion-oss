import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type AutoCodeQueueRow, type Note } from '../lib/api';
import type { DrawerSessionEntry } from './AutoCodeDrawer/types';
import { DrawerHeader } from './AutoCodeDrawer/DrawerHeader';
import { DrawerFooter } from './AutoCodeDrawer/DrawerFooter';
import { EmptyState } from './AutoCodeDrawer/EmptyState';
import { SessionSelector } from './AutoCodeDrawer/SessionSelector';
import { TranscriptBody } from './AutoCodeDrawer/TranscriptBody';
import { PausedAskUserCTA } from './AutoCodeDrawer/PausedAskUserCTA';
import { RunSummarySection } from './AutoCodeDrawer/RunSummarySection';
import { RunFilesSection } from './AutoCodeDrawer/RunFilesSection';
import { RunStatusBar } from './AutoCodeDrawer/RunStatusBar';
import { WorkflowAssignmentSection } from './AutoCodeDrawer/WorkflowAssignmentSection';

export type { DrawerSessionEntry } from './AutoCodeDrawer/types';

/**
 * Auto-code Phase 3 — transcript drawer
 * (sub-ticket 01KQEEDPHX13B92BXKH8G3M9EG, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * Live read of the JSONL session transcripts the orchestrator's
 * `claude -p` sessions write under `~/.claude/projects/...`. Without
 * this surface, the user has zero visibility into what the headless
 * fix / review session is doing — Claude Desktop's `/resume` picker
 * ignores headless sessions, and the kanban comments only land
 * post-hoc on every state transition (~30+ seconds apart).
 *
 * Opens from the per-note right panel "View auto-code activity"
 * button when at least one queue row exists for the task. Latest
 * row is selected by default; older rows accessible via the run
 * picker for post-hoc triage of escalated/failed runs.
 */

interface Props {
  taskId: string | null;
  taskTitle: string;
  onClose: () => void;
}

export function AutoCodeDrawer({ taskId, taskTitle, onClose }: Props) {
  const [runs, setRuns] = useState<AutoCodeQueueRow[]>([]);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  // Per-ticket workflow assignment (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE)
  // needs folderId + current workflowId. Fetched lazily from the note
  // so the drawer's prop surface stays unchanged for callers
  // (KanbanView, NoteRightPanel). Re-fetched on PATCH success via
  // `handleWorkflowAssigned` so the dropdown reflects the new value
  // without waiting for the parent's live-sync round trip.
  const [note, setNote] = useState<Note | null>(null);
  useEffect(() => {
    if (!taskId) {
      setNote(null);
      return;
    }
    let cancelled = false;
    void api
      .getNote(taskId)
      .then((n) => {
        if (!cancelled) setNote(n ?? null);
      })
      .catch(() => {
        if (!cancelled) setNote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  const handleWorkflowAssigned = (next: string | null) => {
    setNote((prev) => (prev ? { ...prev, workflowId: next } : prev));
  };
  // Replaces the old fix/review tab state. Null until the sessions
  // probe lands. Auto-select: latest 'running' session if any, else
  // the last in the list (newest stage by ULID order).
  const [sessions, setSessions] = useState<DrawerSessionEntry[]>([]);
  const [sessionSel, setSessionSel] = useState<DrawerSessionEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load run list when the drawer opens. Re-poll every 5s while
  // open so a fresh tick that creates a new row surfaces without
  // a manual refresh.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { rows } = await api.getAutoCodeRuns(taskId);
        if (cancelled) return;
        setRuns(rows);
        if (rows.length > 0 && !selectedRowId) {
          setSelectedRowId(rows[0]!.id);
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    };
    void load();
    const poll = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // selectedRowId is intentionally excluded — we don't want load
    // to re-fire when the user switches runs (that's a one-shot UI
    // state change, not a server refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Sessions list probe — re-runs every time the user selects a
  // different run OR the run polled above changes state (so a fresh
  // stage that just started a session appears in the dropdown
  // automatically). Auto-select rule:
  //   1. Preserve the user's pick if it's still in the list (by
  //      rowId for workflow, stageId for legacy).
  //   2. Else: latest 'running' stage (workflow live state).
  //   3. Else: last entry in the list (newest by ULID).
  useEffect(() => {
    if (!selectedRowId) {
      setSessions([]);
      setSessionSel(null);
      return;
    }
    let cancelled = false;
    const loadSessions = async () => {
      try {
        const { sessions: list } = await api.getAutoCodeRunSessions(selectedRowId);
        if (cancelled) return;
        setSessions(list);
        setSessionSel((prev) => {
          if (prev) {
            const stillThere = list.find(
              (s) =>
                (s.engine === 'workflow' && s.rowId && s.rowId === prev.rowId) ||
                (s.engine === 'legacy' && s.stageId === prev.stageId),
            );
            if (stillThere) return stillThere;
          }
          const running = list.find((s) => s.status === 'running');
          if (running) return running;
          return list.length > 0 ? list[list.length - 1]! : null;
        });
      } catch (e) {
        if (!cancelled) {
          // Sessions probe failing isn't fatal — the drawer can still
          // show the run row's header. Quietly empty so the selector
          // hides itself.
          setSessions([]);
          setSessionSel(null);
        }
      }
    };
    void loadSessions();
    const poll = setInterval(loadSessions, 5_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [selectedRowId, runs]);

  if (!taskId) return null;

  const selectedRow = runs.find((r) => r.id === selectedRowId) ?? null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <DrawerHeader
          taskTitle={taskTitle}
          runs={runs}
          selectedRowId={selectedRowId}
          onSelectRow={setSelectedRowId}
          onClose={onClose}
        />
        {taskId && note?.folderId && (
          <WorkflowAssignmentSection
            taskId={taskId}
            folderId={note.folderId}
            currentWorkflowId={note.workflowId}
            runs={runs}
            onAssigned={handleWorkflowAssigned}
          />
        )}
        {error && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {selectedRow ? (
          <>
            <RunStatusBar row={selectedRow} />
            {selectedRow.state === 'paused_ask_user' && (
              <PausedAskUserCTA row={selectedRow} />
            )}
            {(selectedRow.state === 'done' || selectedRow.state === 'done_merged') && (
              <>
                <RunSummarySection row={selectedRow} />
                <RunFilesSection row={selectedRow} />
              </>
            )}
            <SessionSelector
              sessions={sessions}
              selected={sessionSel}
              onChange={setSessionSel}
            />
            {sessionSel ? (
              <>
                <TranscriptBody
                  key={`${selectedRow.id}:${sessionSel.engine}:${sessionSel.rowId ?? sessionSel.stageId}`}
                  rowId={selectedRow.id}
                  session={sessionSel}
                />
                <DrawerFooter row={selectedRow} session={sessionSel} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {sessions.length === 0
                  ? 'No agent sessions yet — Mo will start spawning stages once the run picks up.'
                  : 'Pick a session above to view its transcript.'}
              </div>
            )}
          </>
        ) : (
          <EmptyState hasAnyRuns={runs.length > 0} />
        )}
      </div>
    </div>,
    document.body,
  );
}



