/**
 * Mime type set on `dataTransfer` during a folder-reorder drag.
 *
 * WebKit (WKWebView, the engine Tauri uses on macOS) requires at
 * least one `setData(mime, ...)` call inside `onDragStart` for the
 * OS-level drag to actually initiate. Chromium tolerates an empty
 * dragstart and starts the drag anyway — that's why folder reorder
 * worked in `npm run dev:web` but silently no-op'd in the Tauri
 * desktop app until we set this. Ticket `01KQ2WG1B0XEVV3EKT43357B4H`.
 *
 * Distinct from `NOTE_DRAG_MIME` so `isNoteDrag(e)` keeps detecting
 * note drags only — note→folder move continues to work and a folder
 * drag won't masquerade as a note drag in the Sidebar dragover
 * branches.
 */
export const FOLDER_DRAG_MIME = 'application/x-morion-folder';

/**
 * Pure helper extracted from the JSX so the WKWebView-required
 * `setData` + `effectAllowed` contract is unit-testable without
 * jsdom / RTL. Called from `onDragStart` on each folder row.
 *
 * Sets `setData(FOLDER_DRAG_MIME, folderId)` so WKWebView initiates
 * the drag, sets `effectAllowed='move'` so the cursor renders the
 * move affordance, and notifies the caller (`setDraggedFolderId`) so
 * the dragover/drop branches in the Sidebar know which folder the
 * user is reordering.
 */
export function applyFolderDragStart(
  dataTransfer: { setData: (mime: string, value: string) => void; effectAllowed: string },
  folderId: string,
  setDraggedFolderId: (id: string) => void,
): void {
  dataTransfer.setData(FOLDER_DRAG_MIME, folderId);
  dataTransfer.effectAllowed = 'move';
  setDraggedFolderId(folderId);
}
