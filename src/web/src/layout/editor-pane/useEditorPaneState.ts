import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note, Tag } from '../../lib/api';

/**
 * State bag for EditorPane — local body draft, popover toggles, and the
 * two cross-cutting effects that keep them in sync with prop changes.
 *
 * # Hook-ordering invariant (CLAUDE.md autosave rule)
 *
 * `useEditorPaneState` MUST be called BEFORE EditorPane reads `note.body`
 * for render. The note-id-change effect resets `body` from props when the
 * user navigates to a different note; if you call this after rendering
 * Tiptap with the old body the editor will flash the stale content for a
 * frame. The `externalSyncToken` effect (revision restore) has the same
 * "props are the source of truth, NOT the live editor state" semantic —
 * reordering breaks restore.
 *
 * The two effects intentionally do NOT bump `lastSyncTokenRef` on every
 * `note` prop change. That would clobber in-flight typing because App.tsx
 * round-trips `body` back through props on every keystroke (optimistic
 * merge). The sync-token is the explicit "external rewrite, please
 * resync" signal — see Props.externalSyncToken JSDoc on EditorPane.
 */
export function useEditorPaneState({
  note,
  externalSyncToken,
  allTags,
}: {
  note: Note | null;
  externalSyncToken: number | undefined;
  allTags: Tag[];
}) {
  const [body, setBody] = useState(note?.body ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const activeIdRef = useRef<string | null>(note?.id ?? null);
  const lastSyncTokenRef = useRef<number | undefined>(externalSyncToken);
  // Footer "Edited X" → version-history popover. Anchor is the button
  // itself, captured via callback ref so the popover can position
  // relative to it.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Selection changed — reset local state from the freshly selected note.
    if (note?.id !== activeIdRef.current) {
      activeIdRef.current = note?.id ?? null;
      setBody(note?.body ?? '');
      setPickerOpen(false);
      // Close the version-history popover when the user navigates to a
      // different note — its contents are noteId-scoped and would
      // otherwise briefly show the previous note's history before
      // refetching.
      setHistoryOpen(false);
    }
  }, [note?.id, note?.body]);

  // External rewrite of the current note (revision restore). Force-resync
  // local body from the now-updated note prop. We deliberately do NOT do
  // this on every note prop change because that would clobber the user's
  // in-flight typing — the optimistic merge in App.tsx round-trips body
  // back through props on every keystroke.
  useEffect(() => {
    if (externalSyncToken === undefined) return;
    if (externalSyncToken === lastSyncTokenRef.current) return;
    lastSyncTokenRef.current = externalSyncToken;
    if (note) {
      setBody(note.body);
      setHistoryOpen(false);
    }
  }, [externalSyncToken, note]);

  // Lookup table so chips can pull catalogue colors by tag name.
  const tagsByName = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of allTags) m.set(t.name, t);
    return m;
  }, [allTags]);

  return {
    body,
    setBody,
    pickerOpen,
    setPickerOpen,
    historyOpen,
    setHistoryOpen,
    historyAnchor,
    setHistoryAnchor,
    tagsByName,
  };
}
