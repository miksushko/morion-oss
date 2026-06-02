import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Note } from '../lib/api';
import type { AppView, SaveState } from '../appShellTypes';
import { isEmptyDraftNote } from '../lib/discardEmptyNote';
import { deriveTitleFromBody } from '../lib/deriveTitle';
import { flushPendingPatchKeepalive } from '../lib/keepaliveFlush';

const SAVE_DEBOUNCE_MS = 500;

/**
 * How long we wait between active-editing snapshots into the version
 * history. Picked to match the Notion / Google Docs cadence — frequent
 * enough that a sustained writing session leaves recoverable checkpoints,
 * loose enough that the recent-3 + baseline retention isn't churned every
 * 30 seconds. We deliberately do NOT reset on every keystroke; the goal
 * is "at most one snapshot per ~10 min of active editing", not "snapshot
 * 10 min after the last keystroke", which a steady typer would never
 * reach.
 */
const REVISION_IDLE_INTERVAL_MS = 10 * 60 * 1000;

export interface UseAutosaveArgs {
  selectedId: string | null;
  view: AppView;
  allNotes: Note[];
  setAllNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  refreshNotes: () => Promise<void>;
  showToast: (message: string) => void;
}

export interface UseAutosaveReturn {
  /** Per-note save state. Drives the footer indicator inside EditorPane. */
  saveStates: Map<string, SaveState>;
  /** Wire to EditorPane's `onChange`. Optimistic local merge + debounced PATCH. */
  handleEdit: (patch: { body?: string }) => void;
  /** Navigate-away helper: flush pending PATCH then snapshot a revision. */
  flushAndSnapshotForRevision: (id: string) => Promise<void>;
  /** Returns true if the note was an empty fresh/edited draft and got discarded. */
  maybeDiscardEmptyNote: (id: string) => boolean;
  /** Add the note id to the fresh-draft set so it's eligible for discard sweep. */
  markFresh: (id: string) => void;
  /** Drop the note id from both session-tracking sets (explicit delete / bulk delete). */
  forgetNote: (id: string) => void;
  /** Abort any debounced PATCH for the note (used before restoreRevision). */
  cancelPendingSave: (id: string) => void;
}

/**
 * Per-note autosave + revision-snapshot + empty-draft-discard machinery.
 *
 * Three interlocking timers per note:
 *   1. Debounced PATCH (500ms after the last keystroke). Drives
 *      `saveState` (saving → saved flash → idle).
 *   2. Idle revision snapshot (~10 min of active editing). Best-effort
 *      checkpoint into version history; navigate-away path catches any
 *      state it misses.
 *   3. Empty-draft discard. Notes created via the local "+" button OR
 *      edited in this session are tracked; on navigate-away we delete
 *      them if their body is still empty.
 *
 * Cross-cutting effects:
 *   - Nav-watch: fires on every (selectedId, view) change to sweep the
 *     previous selection (discard-empty + flush + revision snapshot).
 *   - Unmount: flush all pending PATCHes + sweep any still-empty fresh
 *     drafts so closing the tab on a never-touched note takes it with us.
 *   - pagehide / visibilitychange→hidden: keepalive flush so the
 *     browser ships pending bytes even when the SPA is being torn down.
 *
 * Lifted out of `App.tsx` as a leaf-but-coupled slice — the hook owns
 * all timers/refs internally; the caller only sees a small surface
 * (`handleEdit`, `markFresh`, `forgetNote`, `cancelPendingSave`, plus
 * the `saveStates` map and the two helpers the nav-watch publishes).
 */
export function useAutosave(args: UseAutosaveArgs): UseAutosaveReturn {
  const { selectedId, view, allNotes, setAllNotes, refreshNotes, showToast } = args;

  // Per-note debounced save state. Keyed by note id so switching notes
  // mid-edit still flushes the previous note's pending patch instead of
  // dropping it.
  const pendingPatchesRef = useRef<Map<string, { body?: string }>>(new Map());
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Per-note save state. Drives the footer indicator inside EditorPane and
  // lets us flag a failed save with a sticky "Save failed" badge instead of
  // silently swallowing the error in `.catch(console.error)`.
  const [saveStates, setSaveStates] = useState<Map<string, SaveState>>(new Map());
  const setSaveState = useCallback((id: string, state: SaveState) => {
    setSaveStates((cur) => {
      const next = new Map(cur);
      next.set(id, state);
      return next;
    });
  }, []);

  // Per-note "saved" → "idle" cooldown timers. Without this the footer would
  // get stuck on "Saved" forever after the last edit. Each successful save
  // bumps the cooldown to two seconds — long enough that the user notices,
  // short enough that we drop back to a clean "Edited X" stamp.
  const savedFlashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const flashSaved = useCallback(
    (id: string) => {
      setSaveState(id, 'saved');
      const existing = savedFlashTimersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        savedFlashTimersRef.current.delete(id);
        setSaveStates((cur) => {
          // Only drop back to idle if nothing else has happened since.
          if (cur.get(id) !== 'saved') return cur;
          const next = new Map(cur);
          next.set(id, 'idle');
          return next;
        });
      }, 2000);
      savedFlashTimersRef.current.set(id, t);
    },
    [setSaveState],
  );

  // Per-note "armed for next idle snapshot" timer. We schedule one when the
  // user first edits a note after the last snapshot/load and let it fire
  // once after REVISION_IDLE_INTERVAL_MS of wall-clock time. The fire writes
  // a snapshot (server dedup makes it a no-op if nothing actually changed)
  // and disarms the slot — the next keystroke re-arms it.
  const revisionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const cancelRevisionTimer = useCallback((id: string) => {
    const t = revisionTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      revisionTimersRef.current.delete(id);
    }
  }, []);

  // Notes eligible for empty-discard on navigate-away.
  // - freshNoteIdsRef: notes created via the local "+" button this session
  // - editedNoteIdsRef: notes the user actually edited this session
  // Only notes in either set are checked by maybeDiscardEmptyNote. This
  // prevents viewing an existing empty note from silently deleting it.
  const freshNoteIdsRef = useRef<Set<string>>(new Set());
  const editedNoteIdsRef = useRef<Set<string>>(new Set());

  // Synchronous mirror of `allNotes` for callbacks (discard sweep, unmount
  // flush) that need to read the latest state without re-running on every
  // notes change. Updating during render is intentional and idiomatic for
  // refs — it keeps the mirror in lockstep with the rendered state.
  const allNotesRef = useRef(allNotes);
  allNotesRef.current = allNotes;

  const markFresh = useCallback((id: string) => {
    freshNoteIdsRef.current.add(id);
  }, []);

  const forgetNote = useCallback((id: string) => {
    freshNoteIdsRef.current.delete(id);
    editedNoteIdsRef.current.delete(id);
  }, []);

  const cancelPendingSave = useCallback((id: string) => {
    const timer = saveTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      saveTimersRef.current.delete(id);
    }
    pendingPatchesRef.current.delete(id);
  }, []);

  /**
   * Discard an empty note on navigate-away, but ONLY if the user
   * created or edited it in this session. Viewing an existing empty
   * note without editing it will NOT delete it.
   *
   * N15 2026-04-16: race with MCP delete. If an MCP client hard-purged
   * or soft-deleted the note between the nav check and our delete
   * call, `api.deleteNote` 404s. Fixed order:
   *   1. Optimistic remove from allNotes (fast UX).
   *   2. Clear debounce timers + pending patches (no more writes).
   *   3. Call delete+purge.
   *      - Success: clear freshNoteIds/editedNoteIds.
   *      - 404: silently drop — the note is already gone.
   *      - Other error: keep the refs so a next nav-away retries,
   *        refresh allNotes (restores the row if the server still has it).
   */
  const maybeDiscardEmptyNote = useCallback(
    (id: string): boolean => {
      const isFresh = freshNoteIdsRef.current.has(id);
      const wasEdited = editedNoteIdsRef.current.has(id);
      if (!isFresh && !wasEdited) return false;

      const note = allNotesRef.current.find((n) => n.id === id);
      if (!note) {
        // Already gone from the local list — an earlier MCP delete or
        // live-sync refresh dropped it.
        freshNoteIdsRef.current.delete(id);
        editedNoteIdsRef.current.delete(id);
        return false;
      }
      if (!isEmptyDraftNote(note)) return false;

      const timer = saveTimersRef.current.get(id);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(id);
      pendingPatchesRef.current.delete(id);
      setAllNotes((cur) => cur.filter((n) => n.id !== id));
      api
        .deleteNote(id)
        .then(() => api.purgeNote(id))
        .then(() => {
          freshNoteIdsRef.current.delete(id);
          editedNoteIdsRef.current.delete(id);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const wasGone = /\b404\b/.test(msg);
          if (wasGone) {
            freshNoteIdsRef.current.delete(id);
            editedNoteIdsRef.current.delete(id);
            return;
          }
          console.error('Failed to discard empty note', err);
          refreshNotes().catch(console.error);
        });
      return true;
    },
    [setAllNotes, refreshNotes],
  );

  /**
   * Flush any pending debounced save for `id` then ask the server to
   * snapshot the resulting state into the version history. Best-effort:
   * if the flush fails we skip the snapshot; if the snapshot fails we
   * just log it. Neither blocks the UI.
   */
  const flushAndSnapshotForRevision = useCallback(
    async (id: string) => {
      const timer = saveTimersRef.current.get(id);
      const pending = pendingPatchesRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        saveTimersRef.current.delete(id);
      }
      cancelRevisionTimer(id);
      if (pending) {
        pendingPatchesRef.current.delete(id);
        try {
          const updated = await api.updateNote(id, pending);
          setAllNotes((cur) =>
            cur.map((n) => {
              if (n.id !== id) return n;
              const stillPending = pendingPatchesRef.current.get(id) ?? {};
              return { ...updated, ...stillPending };
            }),
          );
          flashSaved(id);
        } catch (err) {
          console.error('flush before snapshot failed', err);
          setSaveState(id, 'error');
          showToast('Save failed — your last edit may be lost');
          return;
        }
      }
      const note = allNotesRef.current.find((n) => n.id === id);
      if (!note || isEmptyDraftNote(note)) return;
      try {
        await api.createRevision(id);
      } catch (err) {
        console.error('createRevision failed', err);
      }
    },
    [cancelRevisionTimer, flashSaved, setSaveState, setAllNotes, showToast],
  );

  /**
   * Optimistic local merge + debounced server PATCH. Drives the per-note
   * save-state indicator and arms the idle revision timer.
   */
  const handleEdit = useCallback(
    (patch: { body?: string }) => {
      if (!selectedId) return;
      const id = selectedId;

      // Mark this note as edited so the discard sweep can catch it if the
      // user erases everything and navigates away.
      editedNoteIdsRef.current.add(id);

      // Derive the display title from the body so NotesList shows it in real
      // time (Apple Notes style — first line of the body IS the title).
      const optimistic: Partial<Note> = { ...patch };
      if (patch.body !== undefined) {
        optimistic.title = deriveTitleFromBody(patch.body);
      }

      setAllNotes((cur) => cur.map((n) => (n.id === id ? { ...n, ...optimistic } : n)));

      const merged = { ...pendingPatchesRef.current.get(id), ...patch };
      pendingPatchesRef.current.set(id, merged);
      setSaveState(id, 'saving');

      // Arm the idle revision snapshot timer iff one isn't already running
      // for this note.
      if (!revisionTimersRef.current.has(id)) {
        const revTimer = setTimeout(() => {
          revisionTimersRef.current.delete(id);
          const note = allNotesRef.current.find((n) => n.id === id);
          if (!note || isEmptyDraftNote(note)) return;
          api.createRevision(id).catch((err) => {
            console.error('idle revision snapshot failed', err);
          });
        }, REVISION_IDLE_INTERVAL_MS);
        revisionTimersRef.current.set(id, revTimer);
      }

      const existing = saveTimersRef.current.get(id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        const toSend = pendingPatchesRef.current.get(id);
        pendingPatchesRef.current.delete(id);
        saveTimersRef.current.delete(id);
        if (!toSend) return;
        api
          .updateNote(id, toSend)
          .then((updated) => {
            setAllNotes((cur) =>
              cur.map((n) => {
                if (n.id !== id) return n;
                const stillPending = pendingPatchesRef.current.get(id) ?? {};
                return { ...updated, ...stillPending };
              }),
            );
            if (!pendingPatchesRef.current.has(id)) {
              flashSaved(id);
            }
          })
          .catch((err) => {
            console.error('autosave failed', err);
            setSaveState(id, 'error');
            showToast('Save failed — your last edit may be lost');
            // Put the patch back so the next keystroke / pagehide flush
            // still has the bytes to send.
            const stillPending = pendingPatchesRef.current.get(id);
            pendingPatchesRef.current.set(id, { ...toSend, ...stillPending });
          });
      }, SAVE_DEBOUNCE_MS);
      saveTimersRef.current.set(id, timer);
    },
    [selectedId, setSaveState, flashSaved, setAllNotes, showToast],
  );

  // Nav-watch: sweep the previous selection whenever the user moves to a
  // different note/view. Mobile pane navigation alone is NOT a trigger.
  const navWatchRef = useRef<{ selectedId: string | null; view: AppView }>({
    selectedId,
    view,
  });
  useEffect(() => {
    const prev = navWatchRef.current;
    navWatchRef.current = { selectedId, view };
    if (prev.selectedId === null) return;
    const stillOnPrev =
      prev.selectedId === selectedId && prev.view === 'notes' && view === 'notes';
    if (stillOnPrev) return;
    const discarded = maybeDiscardEmptyNote(prev.selectedId);
    // Skip flush+snapshot when the note was just hard-deleted — the server
    // would 404 on the PATCH and log a spurious error.
    if (!discarded) flushAndSnapshotForRevision(prev.selectedId);
  }, [selectedId, view, maybeDiscardEmptyNote, flushAndSnapshotForRevision]);

  // Unmount cleanup — flush in-flight saves + best-effort discard empty
  // fresh/edited drafts. Mounts once.
  useEffect(() => {
    const timers = saveTimersRef.current;
    const patches = pendingPatchesRef.current;
    const fresh = freshNoteIdsRef.current;
    const edited = editedNoteIdsRef.current;
    const flashTimers = savedFlashTimersRef.current;
    const revTimers = revisionTimersRef.current;
    return () => {
      for (const [id, timer] of timers.entries()) {
        clearTimeout(timer);
        const toSend = patches.get(id);
        if (toSend) api.updateNote(id, toSend).catch(console.error);
      }
      timers.clear();
      patches.clear();
      for (const t of flashTimers.values()) clearTimeout(t);
      flashTimers.clear();
      for (const t of revTimers.values()) clearTimeout(t);
      revTimers.clear();
      const discardable = new Set([...fresh, ...edited]);
      for (const id of discardable) {
        const note = allNotesRef.current.find((n) => n.id === id);
        if (note && isEmptyDraftNote(note)) {
          api.deleteNote(id).then(() => api.purgeNote(id)).catch(console.error);
        }
      }
      fresh.clear();
      edited.clear();
    };
  }, []);

  /**
   * Last-gasp save when the tab is being torn down. React's unmount
   * cleanup is NOT guaranteed to run on tab close/refresh; any inflight
   * `fetch` would be killed with the page. `pagehide` (bfcache-friendly
   * replacement for `beforeunload`) and `visibilitychange→hidden`
   * (reliable on iOS Safari) plus `fetch(..., { keepalive: true })`
   * ship every pending patch the moment the page might be going away.
   */
  useEffect(() => {
    const flushAll = () => {
      const patches = pendingPatchesRef.current;
      if (patches.size === 0) return;
      // Cancel pending debounce timers — we're shipping the bytes now.
      for (const [, timer] of saveTimersRef.current.entries()) {
        clearTimeout(timer);
      }
      saveTimersRef.current.clear();
      for (const [id, patch] of patches.entries()) {
        flushPendingPatchKeepalive(id, patch);
      }
      patches.clear();
    };
    const onPageHide = () => flushAll();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushAll();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return {
    saveStates,
    handleEdit,
    flushAndSnapshotForRevision,
    maybeDiscardEmptyNote,
    markFresh,
    forgetNote,
    cancelPendingSave,
  };
}
