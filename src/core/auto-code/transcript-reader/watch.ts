/**
 * Live transcript-file watcher — fs.watch + debounce + parser dispatch.
 * Extracted from `../transcript-reader.ts` (2026-05-16, ticket
 * `01KRQYRTY348DAG9MM6JPMTDYR`).
 */

import { existsSync, watch as fsWatch } from 'node:fs';
import { parseTranscriptFile } from './parse-claude.js';
import { parseHarnessTranscriptFile } from './parse-harness.js';
import type { ParseTranscriptResult } from './types.js';

export interface WatchHandle {
  stop: () => void;
}

/**
 * Watch a transcript file and call `onChange` with the freshly
 * parsed message list whenever the file mtime moves. Debounced to
 * 250ms so a batch of writes (Claude flushes per turn, not per
 * line) doesn't trigger five renders in a row.
 *
 * Returns a handle the caller MUST stop on unmount — fs.watch
 * leaks an OS handle otherwise.
 */
export function watchTranscript(
  path: string,
  onChange: (result: ParseTranscriptResult) => void,
  opts: {
    debounceMs?: number;
    /** Which JSONL format the watched file uses:
     *    - 'claude'  — Claude's `~/.claude/projects/<encoded>/<sid>.jsonl`
     *                  shape (default; legacy auto-code path).
     *    - 'harness' — workflow runner's `~/.morion/runs/<sid>.jsonl`
     *                  CliAgentEvent shape (Pi / Codex / Opencode /
     *                  claude-via-harness; Phase 4+). */
    parser?: 'claude' | 'harness';
  } = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 250;
  const parser = opts.parser ?? 'claude';
  let pending: NodeJS.Timeout | null = null;
  let stopped = false;
  let watcher: ReturnType<typeof fsWatch> | null = null;

  const fire = async () => {
    pending = null;
    if (stopped) return;
    try {
      const result =
        parser === 'harness'
          ? await parseHarnessTranscriptFile(path)
          : await parseTranscriptFile(path);
      if (!stopped) onChange(result);
    } catch (err) {
      if (!stopped) {
        onChange({
          messages: [],
          warnings: [`watcher parse failed: ${(err as Error).message}`],
        });
      }
    }
  };

  const debounce = () => {
    if (stopped) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(fire, debounceMs);
  };

  // Fire once immediately so subscribers get the initial state
  // even if the file has been quiet for a while.
  void fire();

  try {
    watcher = fsWatch(path, () => debounce());
  } catch {
    // File doesn't exist yet — fall back to a slow poll until it
    // appears. Common on the very first tick of a fresh worktree.
    const poll = setInterval(() => {
      if (stopped) {
        clearInterval(poll);
        return;
      }
      if (existsSync(path)) {
        clearInterval(poll);
        try {
          watcher = fsWatch(path, () => debounce());
          debounce();
        } catch {
          // Give up silently — caller will retry on next subscription.
        }
      }
    }, 1_000);
    return {
      stop: () => {
        stopped = true;
        clearInterval(poll);
        if (pending) clearTimeout(pending);
      },
    };
  }

  return {
    stop: () => {
      stopped = true;
      if (pending) clearTimeout(pending);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* idempotent */
        }
      }
    },
  };
}
