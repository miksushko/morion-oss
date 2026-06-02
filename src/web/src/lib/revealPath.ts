import { isTauri } from './env';

/**
 * Open a local filesystem path in the OS file manager (Finder on
 * macOS, Explorer on Windows, default file manager on Linux).
 *
 * Used by AutoCodeDrawer's "Show files" / "Open in Finder" buttons
 * so non-tech users can see what changed without dropping to a
 * terminal. When `path` points at a file the OS highlights it inside
 * its containing directory; when it's a directory we open the dir
 * itself. Always invoked with backend-controlled paths (worktree dir
 * or linked-repo path) — never user free-text input.
 *
 * Outside Tauri (dev preview at localhost:5173) the IPC bridge isn't
 * available; we surface a clean error to the caller so the UI can
 * fall back to printing the path for the user to copy manually.
 */
export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri) {
    throw new Error('revealInFinder is only available in the desktop app');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('reveal_in_finder', { path });
}

/**
 * Open a local filesystem path in the user's preferred editor.
 * Tries `code <path>` first (VS Code's standard launcher); falls
 * back to the OS default app for the file type when `code` is
 * missing from PATH. For directories opened via `code` this shows
 * the folder in VS Code's file tree — handy for reviewing what an
 * auto-code run touched.
 */
export async function openInEditor(path: string): Promise<void> {
  if (!isTauri) {
    throw new Error('openInEditor is only available in the desktop app');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_in_editor', { path });
}
