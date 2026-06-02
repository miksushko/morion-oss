/**
 * Regression: folder reorder by drag was a no-op in the Tauri desktop
 * app (works in dev/web Chromium).
 *
 * Ticket: `01KQ2WG1B0XEVV3EKT43357B4H`. Root cause was the folder
 * row's `onDragStart` not calling `e.dataTransfer.setData(...)`.
 * WebKit (WKWebView, the engine Tauri uses on macOS) refuses to
 * initiate a drag without at least one `setData` call. Chromium
 * tolerates an empty dragstart, so dev-browser dogfooding never
 * tripped it.
 *
 * Fix lives in `src/web/src/layout/Sidebar.tsx`: the dragstart logic
 * is extracted into `applyFolderDragStart` so this test can pin the
 * setData contract without standing up jsdom + RTL.
 */
import { describe, it, expect } from 'vitest';
import {
  applyFolderDragStart,
  FOLDER_DRAG_MIME,
} from '../src/web/src/layout/sidebar/folder-drag';
import { NOTE_DRAG_MIME } from '../src/web/src/layout/NotesList';

class StubDataTransfer {
  data = new Map<string, string>();
  effectAllowed = '';
  setData(mime: string, value: string): void {
    this.data.set(mime, value);
  }
}

describe('applyFolderDragStart (01KQ2WG1B0XEVV3EKT43357B4H)', () => {
  it('calls setData with FOLDER_DRAG_MIME so WKWebView initiates the drag', () => {
    const dt = new StubDataTransfer();
    let captured: string | null = null;
    applyFolderDragStart(dt, 'folder_alpha', (id) => {
      captured = id;
    });
    // The literal contract WKWebView requires.
    expect(dt.data.get(FOLDER_DRAG_MIME)).toBe('folder_alpha');
  });

  it('sets effectAllowed=move so the cursor renders the move affordance', () => {
    const dt = new StubDataTransfer();
    applyFolderDragStart(dt, 'f', () => {});
    expect(dt.effectAllowed).toBe('move');
  });

  it('notifies the caller of the dragged folder id (Sidebar state machine)', () => {
    const dt = new StubDataTransfer();
    let captured: string | null = null;
    applyFolderDragStart(dt, 'folder_beta', (id) => {
      captured = id;
    });
    expect(captured).toBe('folder_beta');
  });

  it('FOLDER_DRAG_MIME is distinct from NOTE_DRAG_MIME so isNoteDrag still works', () => {
    // The Sidebar's `isNoteDrag(e)` check looks at
    // `e.dataTransfer.types.includes(NOTE_DRAG_MIME)`. A folder drag
    // must not match it, otherwise dropping a folder onto another
    // folder would be misclassified as a note move.
    expect(FOLDER_DRAG_MIME).not.toBe(NOTE_DRAG_MIME);
    expect(FOLDER_DRAG_MIME).toBe('application/x-morion-folder');
    expect(NOTE_DRAG_MIME).toBe('application/x-morion-note');
  });
});
