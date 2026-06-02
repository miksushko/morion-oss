import { useCallback, useState } from 'react';
import type { MobilePane } from '../appShellTypes';

/**
 * Mobile-pane visibility state + the `paneClass` helper.
 *
 * On `md+` viewports every pane is always visible (`md:flex`). On
 * narrow viewports the active pane takes the full width and the
 * others collapse to `hidden`. Using `display` (not opacity) means
 * the off-screen panes don't steal touches and don't reserve layout.
 *
 * Editor-fullscreen toggles via ⌘⇧F — when on, only the editor pane
 * is visible regardless of `mobilePane`.
 */
export function useMobilePane(initial: MobilePane = 'folders') {
  const [mobilePane, setMobilePane] = useState<MobilePane>(initial);
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  const paneClass = useCallback(
    (pane: MobilePane) => {
      if (editorFullscreen && pane !== 'editor') return 'hidden';
      return mobilePane === pane ? 'flex w-full md:w-auto' : 'hidden md:flex';
    },
    [editorFullscreen, mobilePane],
  );

  return { mobilePane, setMobilePane, editorFullscreen, setEditorFullscreen, paneClass };
}
