/**
 * Shared type aliases used by the App shell + hooks split out of
 * `App.tsx`. Kept in their own module so hooks can import the types
 * without dragging the full App component in.
 */

export type AppView = 'notes' | 'tags' | 'trash' | 'concierge';

/**
 * Which pane the user is currently looking at on a narrow viewport. On
 * desktop (>= md) all three are visible at once and this is ignored.
 * On mobile (< md) we stack like Apple Notes / Mail.app: folders →
 * notes → editor with a back button to walk the stack back up.
 */
export type MobilePane = 'folders' | 'notes' | 'editor';

/**
 * Per-note autosave indicator state. The footer of EditorPane reflects
 * whichever value is keyed to the currently selected note.
 *
 * `idle`     - no edits since the last successful save (or fresh load)
 * `saving`   - the user just typed; debounce timer running OR PATCH inflight
 * `saved`    - the most recent PATCH succeeded; the footer briefly says so
 * `error`    - the most recent PATCH failed; user gets a toast + sticky badge
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
