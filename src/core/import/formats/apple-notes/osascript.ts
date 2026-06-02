import { spawn } from 'node:child_process';
import {
  AppleNotesNotInstalledError,
  AppleNotesPermissionError,
} from './types.js';

const OSASCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for large exports

export async function runOsascript(script: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Apple Notes import cancelled before osascript spawn.'));
      return;
    }
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[apple-notes] osascript spawn (script ${script.length} chars)`);
    const proc = spawn('osascript', ['-l', 'AppleScript', '-e', script], {
      env: { ...process.env, LANG: 'en_US.UTF-8' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, OSASCRIPT_TIMEOUT_MS);

    // Cancel-from-UI path: engine.cancel() aborts the signal → we
    // SIGTERM osascript so it stops chewing CPU. Without this, a
    // stuck AppleScript run blocks the registry for the full
    // 5-minute timeout (or forever, if the user reloads the page —
    // the IIFE in the route keeps awaiting the spawn promise and
    // never releases the import slot).
    const onAbort = (): void => {
      aborted = true;
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (err.message.includes('ENOENT')) {
        reject(new AppleNotesNotInstalledError('osascript not found — is this macOS?'));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      const ms = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[apple-notes] osascript close code=${code} timedOut=${timedOut} aborted=${aborted} ms=${ms} stdout=${stdout.length}b stderr=${stderr.length}b`,
      );
      if (aborted) {
        reject(new Error('Apple Notes import cancelled.'));
        return;
      }
      if (timedOut) {
        reject(new Error('AppleScript timed out after 5 minutes.'));
        return;
      }
      // AppleScript `log` statements come through stderr even on
      // success — surface them so `failed to read note` warnings
      // hit the server log instead of disappearing.
      if (stderr.trim().length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[apple-notes] osascript stderr:', stderr.trim());
      }
      if (code !== 0) {
        // -1743 — automation permission not granted
        // -1728 — Notes app not found
        if (stderr.includes('-1743') || stderr.toLowerCase().includes('not authorized')) {
          reject(
            new AppleNotesPermissionError(
              'Morion is not authorized to control Notes. Open System Settings → Privacy & Security → Automation → Morion → enable Notes.',
            ),
          );
        } else if (stderr.includes('-1728') || stderr.toLowerCase().includes("can't get application")) {
          reject(new AppleNotesNotInstalledError('Notes app not found on this machine.'));
        } else {
          reject(
            new Error(
              `osascript exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
            ),
          );
        }
        return;
      }
      resolve(stdout);
    });
  });
}
