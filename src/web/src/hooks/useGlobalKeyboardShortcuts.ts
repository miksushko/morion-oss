import { useEffect } from 'react';
import type { MobilePane } from '../appShellTypes';

/**
 * App-wide keyboard shortcuts. All gated on `metaKey || ctrlKey` so we
 * never steal a plain character keystroke from the editor.
 *
 *   ⌘N      — new note
 *   ⌘K      — toggle search palette
 *   ⌘D      — delete selected note
 *   ⌘1/2/3  — focus folders / notes list / editor pane (mobile-pane
 *             switch; on desktop the panes are always visible)
 *   ⌘⇧F     — toggle editor fullscreen
 *
 * Lives in App.tsx because every handler mutates app-level state. The
 * callbacks bag below is the boundary — keep it narrow so a new
 * shortcut doesn't drag unrelated app state into this hook.
 */
export interface GlobalShortcutHandlers {
  newNote: () => void | Promise<void>;
  deleteSelected: () => void | Promise<void>;
  togglePalette: () => void;
  setMobilePane: (pane: MobilePane) => void;
  setEditorFullscreen: (next: boolean | ((cur: boolean) => boolean)) => void;
}

export function useGlobalKeyboardShortcuts(handlers: GlobalShortcutHandlers) {
  const {
    newNote,
    deleteSelected,
    togglePalette,
    setMobilePane,
    setEditorFullscreen,
  } = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        void newNote();
      } else if (key === 'k') {
        e.preventDefault();
        togglePalette();
      } else if (key === 'd') {
        e.preventDefault();
        void deleteSelected();
      } else if (key === '1') {
        e.preventDefault();
        setMobilePane('folders');
        setEditorFullscreen(false);
      } else if (key === '2') {
        e.preventDefault();
        setMobilePane('notes');
        setEditorFullscreen(false);
      } else if (key === '3') {
        e.preventDefault();
        setMobilePane('editor');
        setEditorFullscreen(false);
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        setEditorFullscreen((cur) => !cur);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newNote, deleteSelected, togglePalette, setMobilePane, setEditorFullscreen]);
}
