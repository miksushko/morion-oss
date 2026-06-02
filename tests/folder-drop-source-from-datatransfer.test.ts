/**
 * Regression: folder reorder by drag silently failed in the Tauri
 * macOS prod build even after the WKWebView `setData` fix (ticket
 * `01KQ2WG1B0XEVV3EKT43357B4H`). The drag would initiate but never
 * produce a drop.
 *
 * Root cause: `FolderTree.onDragOver` and `handleFolderDrop` read the
 * dragged folder id from React state (`draggedFolderId`), not from
 * `dataTransfer`. The state is set inside the `setDraggedFolderId`
 * call inside `onDragStart`. In Chromium the React commit lands
 * before the first `dragover` fires on the target, so the predicate
 * sees the id and `e.preventDefault()` runs. WKWebView's drag-event
 * scheduling can fire `dragover` before React commits — the
 * predicate sees `null`, skips `preventDefault`, and the OS never
 * delivers `drop`. The user sees nothing happen.
 *
 * Fix: read the source folder id from
 * `e.dataTransfer.getData(FOLDER_DRAG_MIME)` on drop, and gate
 * `dragover` on `e.dataTransfer.types.includes(FOLDER_DRAG_MIME)`.
 * Both are stable across the dragstart→dragover→drop sequence in
 * every engine. React state stays purely for the dragged-row visual
 * cue (a small lag there is invisible to the user).
 *
 * This test pins the contract: the new drop path uses dataTransfer
 * as its source of truth, NOT React state.
 *
 * Ticket: 01KRZAC71PANN4XVGMB3TBGV75
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '..', 'src/web/src/layout/sidebar/FolderTree.tsx'),
  'utf8',
);

describe('FolderTree drag uses dataTransfer, not React state (01KRZAC71PANN4XVGMB3TBGV75)', () => {
  it('imports FOLDER_DRAG_MIME so it can read the source id from dataTransfer', () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*FOLDER_DRAG_MIME[^}]*\}\s*from\s*['"]\.\/folder-drag['"]/,
    );
  });

  it('exposes an isFolderDrag predicate that gates on dataTransfer.types', () => {
    expect(SRC).toMatch(
      /isFolderDrag.*=.*dataTransfer\.types\.includes\(FOLDER_DRAG_MIME\)/s,
    );
  });

  it('handleFolderDrop reads the source id via dataTransfer.getData, not React state', () => {
    // Old broken pattern (pre-fix): `if (!draggedFolderId) return; ... computeReorderedFolderIds(folders, draggedFolderId, targetId)`.
    expect(SRC).toMatch(/getData\(FOLDER_DRAG_MIME\)/);
    expect(SRC).not.toMatch(
      /if\s*\(\s*!draggedFolderId\s*\)\s*return;[\s\S]{0,80}computeReorderedFolderIds/,
    );
  });

  it('onDragOver calls preventDefault on any folder-drag, gated by isFolderDrag', () => {
    // The fix accepts every folder dragover (preventDefault always)
    // and lets computeReorderedFolderIds reject cross-group drops on
    // drop. Pre-fix the predicate read React state, so a missed-state
    // dragover skipped preventDefault and the drop never fired.
    expect(SRC).toMatch(/if\s*\(\s*isFolderDrag\(e\)\s*\)\s*\{[\s\S]{0,200}preventDefault/);
  });
});
