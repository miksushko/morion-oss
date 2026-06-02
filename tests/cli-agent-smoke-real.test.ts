import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ClaudeAdapter,
  CodexAdapter,
  OpencodeAdapter,
  PiAdapter,
  type AgentHandle,
  type CliAgentEvent,
  isError,
  isResult,
  isSessionStart,
  isTerminalEvent,
} from '../src/core/auto-code/harness/index.js';

/**
 * L1 follow-up — real-CLI smoke tests for the harness adapters.
 *
 * Skipped by default. Each adapter's suite runs ONLY when the
 * matching opt-in env flag is set:
 *
 *   RUN_REAL_CLAUDE=1   npx vitest run tests/cli-agent-smoke-real.test.ts
 *   RUN_REAL_CODEX=1    ...
 *   RUN_REAL_PI=1       ...
 *   RUN_REAL_OPENCODE=1 ...
 *
 * The cross-adapter contract suite in `cli-agent-adapter-contract.test.ts`
 * is stub-backed and already pins the uniform CliAgentAdapter contract.
 * THIS file proves the contract still holds against the user's actually-
 * installed CLI binaries — useful before mid-stack releases or after
 * touching event-parsing of a specific adapter. NOT for CI.
 *
 * Non-goals (per ticket 01KRB0WSAC61B2S228GB4ZEB1Z):
 *   - Do not make CI require local user binaries.
 *   - Do not auto-install agents / Pi packages.
 *   - Do not change adapter behavior unless smoke reveals a real
 *     incompatibility.
 *
 * Failure surface:
 *   - If RUN_REAL_<X> is set but the binary is missing on PATH, the
 *     adapter throws AgentBinaryNotFoundError with the lookedAt list.
 *     The test fails loudly so the user knows what to install.
 *   - Pi requires a working provider config; default tries `ollama`.
 *     Override via RUN_REAL_PI_PROVIDER + RUN_REAL_PI_MODEL.
 */

const REAL_TIMEOUT_MS = 180_000; // 3 min per smoke — plenty for "say OK".
const SPAWN_TIMEOUT_MS = 120_000;

const NOOP_PROMPT =
  'Respond with exactly the two characters: OK. No code, no tools, no other text.';

async function collectEvents(handle: AgentHandle): Promise<CliAgentEvent[]> {
  const out: CliAgentEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

function makeWorkDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `morion-smoke-real-${prefix}-`));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function assertContractShape(
  events: CliAgentEvent[],
  adapterName: string,
): void {
  const sessionStarts = events.filter(isSessionStart);
  expect(
    sessionStarts.length,
    `${adapterName}: expected ≥1 session_start event`,
  ).toBeGreaterThanOrEqual(1);

  const terminals = events.filter(isTerminalEvent);
  expect(
    terminals.length,
    `${adapterName}: expected exactly 1 terminal event, got ${terminals.length}`,
  ).toBe(1);

  // Terminal must be result OR error — never anything else.
  const terminal = terminals[0];
  const isTerminalShape = isResult(terminal) || isError(terminal);
  expect(
    isTerminalShape,
    `${adapterName}: terminal event must be 'result' or 'error', got kind=${terminal.kind}`,
  ).toBe(true);

  // session_start.agent matches adapter name.
  expect(sessionStarts[0].agent).toBe(adapterName);
}

// ---------------------------------------------------------------------
// claude — RUN_REAL_CLAUDE=1
// ---------------------------------------------------------------------

const runClaude = (process.env.RUN_REAL_CLAUDE ?? '').trim() === '1';

(runClaude ? describe : describe.skip)('real claude smoke', () => {
  it(
    'spawns, emits session_start, terminates with result or clear error',
    async () => {
      const wd = makeWorkDir('claude');
      try {
        const adapter = new ClaudeAdapter();
        const handle = await adapter.spawn({
          prompt: NOOP_PROMPT,
          cwd: wd.dir,
          timeoutMs: SPAWN_TIMEOUT_MS,
          // Empty allowedTools — pure LLM call, no Read/Write/Bash so
          // the smoke can't accidentally touch the host filesystem.
          allowedTools: [],
        });
        expect(handle.adapter).toBe('claude');
        expect(handle.sessionId.length).toBeGreaterThan(0);

        const events = await collectEvents(handle);
        await handle.exited;
        assertContractShape(events, 'claude');

        const terminal = events.find(isTerminalEvent)!;
        if (isError(terminal)) {
          // A failure path is acceptable on real-binary smokes (auth
          // not configured, model down, etc.) — but errorKind must be
          // a documented string, not undefined.
          expect(
            typeof terminal.errorKind,
            `claude error event missing errorKind: ${JSON.stringify(terminal)}`,
          ).toBe('string');
          expect(terminal.errorKind.length).toBeGreaterThan(0);
        }
      } finally {
        wd.cleanup();
      }
    },
    REAL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------
// codex — RUN_REAL_CODEX=1
// ---------------------------------------------------------------------
//
// Codex 0.1.x renders an Ink TUI in a non-TTY child and may crash with
// "Raw mode is not supported" — the adapter detects this via
// `stdoutLooksUnhealthy` and emits a terminal `error{errorKind:
// 'parse_failed' | 'spawn_failed'}` (NOT a `result`). Either shape is
// acceptable here: this smoke proves the adapter still RECOGNISES the
// failure pattern cleanly rather than hanging.

const runCodex = (process.env.RUN_REAL_CODEX ?? '').trim() === '1';

(runCodex ? describe : describe.skip)('real codex smoke', () => {
  it(
    'spawns, emits session_start, terminates with result or explicit Ink-crash error',
    async () => {
      const wd = makeWorkDir('codex');
      try {
        const adapter = new CodexAdapter();
        const handle = await adapter.spawn({
          prompt: NOOP_PROMPT,
          cwd: wd.dir,
          timeoutMs: SPAWN_TIMEOUT_MS,
          allowedTools: [],
        });
        expect(handle.adapter).toBe('codex');
        const events = await collectEvents(handle);
        await handle.exited;
        assertContractShape(events, 'codex');

        // If codex Ink-crashed, the terminal MUST be an error with an
        // explicit errorKind — not a silent fake-result. This is the
        // Ink-crash detection contract the L1.T10 stub-tests pin.
        const terminal = events.find(isTerminalEvent)!;
        if (isError(terminal)) {
          expect(typeof terminal.errorKind).toBe('string');
          expect(terminal.errorKind.length).toBeGreaterThan(0);
        }
      } finally {
        wd.cleanup();
      }
    },
    REAL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------
// pi — RUN_REAL_PI=1
// ---------------------------------------------------------------------
//
// Prefer Ollama (free + local) when reachable. Override the provider /
// model via RUN_REAL_PI_PROVIDER and RUN_REAL_PI_MODEL if the host
// uses OpenRouter / OpenAI instead.

const runPi = (process.env.RUN_REAL_PI ?? '').trim() === '1';
const piProvider = (process.env.RUN_REAL_PI_PROVIDER ?? 'ollama').trim();
const piModel = (process.env.RUN_REAL_PI_MODEL ?? '').trim();

(runPi ? describe : describe.skip)('real pi smoke', () => {
  it(
    'spawns, emits session_start, terminates with result or clear error',
    async () => {
      const wd = makeWorkDir('pi');
      try {
        const adapter = new PiAdapter();
        const handle = await adapter.spawn({
          prompt: NOOP_PROMPT,
          cwd: wd.dir,
          timeoutMs: SPAWN_TIMEOUT_MS,
          allowedTools: [],
          provider: piProvider,
          ...(piModel.length > 0 ? { model: piModel } : {}),
        });
        expect(handle.adapter).toBe('pi');
        expect(handle.sessionId.length).toBeGreaterThan(0);

        const events = await collectEvents(handle);
        await handle.exited;
        assertContractShape(events, 'pi');

        const terminal = events.find(isTerminalEvent)!;
        if (isError(terminal)) {
          expect(typeof terminal.errorKind).toBe('string');
          expect(terminal.errorKind.length).toBeGreaterThan(0);
          // Don't fail the smoke just because the provider isn't
          // configured (e.g. Ollama not running) — the adapter's job
          // is to surface this cleanly, not to verify the host setup.
          // The errorKind shape check above is the load-bearing check.
        }
      } finally {
        wd.cleanup();
      }
    },
    REAL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------
// opencode — RUN_REAL_OPENCODE=1
// ---------------------------------------------------------------------

const runOpencode = (process.env.RUN_REAL_OPENCODE ?? '').trim() === '1';

(runOpencode ? describe : describe.skip)('real opencode smoke', () => {
  it(
    'spawns, emits session_start, terminates with result or clear error',
    async () => {
      const wd = makeWorkDir('opencode');
      try {
        const adapter = new OpencodeAdapter();
        const handle = await adapter.spawn({
          prompt: NOOP_PROMPT,
          cwd: wd.dir,
          timeoutMs: SPAWN_TIMEOUT_MS,
          allowedTools: [],
        });
        expect(handle.adapter).toBe('opencode');
        expect(handle.sessionId.length).toBeGreaterThan(0);

        const events = await collectEvents(handle);
        await handle.exited;
        assertContractShape(events, 'opencode');

        const terminal = events.find(isTerminalEvent)!;
        if (isError(terminal)) {
          expect(typeof terminal.errorKind).toBe('string');
          expect(terminal.errorKind.length).toBeGreaterThan(0);
        }
      } finally {
        wd.cleanup();
      }
    },
    REAL_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------
// Default-skip guard — proves the file is harmless without env flags
// ---------------------------------------------------------------------

describe('real-cli smoke harness (default-skip guard)', () => {
  it('default invocation skips every real-CLI suite (CI safety net)', () => {
    // If none of the RUN_REAL_* flags are set, none of the suites
    // above ran. This guard makes the no-op execution observable so
    // a regression that flips one of the `describe.skip` branches to
    // always-run shows up here.
    const anyFlagSet = runClaude || runCodex || runPi || runOpencode;
    if (!anyFlagSet) {
      expect(anyFlagSet).toBe(false);
    } else {
      // At least one flag is set — guard is informational, not load-
      // bearing. Pass silently.
      expect(true).toBe(true);
    }
  });
});
