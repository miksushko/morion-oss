import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

/** Best-effort extraction of a short error message from an exec
 *  failure — prefers stderr, falls back to message, finally to
 *  String(err). Used uniformly so every git-error surface message
 *  has the same shape. */
export function trimErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) return e.stderr.trim();
    if (typeof e.message === 'string') return e.message.trim();
  }
  return String(err);
}
