import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

import {
  AgentResumeUnsupportedError,
  ClaudeAdapter,
  CodexAdapter,
  OpencodeAdapter,
  PiAdapter,
  type AgentHandle,
  type CliAgentAdapter,
  type CliAgentEvent,
  isError,
  isResult,
  isSessionStart,
  isTerminalEvent,
} from '../src/core/auto-code/harness/index.js';

// ---------------------------------------------------------------------
// FakeCodex — codex SDK injection for the contract suite. After the
// 2026-05-16 SDK migration (ticket 01KRJNFGC1AB0FD81WYMGPMHHH) the
// codex adapter no longer spawns the CLI directly, so the bash-wrapper
// stub approach used by the other adapters doesn't apply. We honor the
// same STUB_VERDICT / STUB_REASON / STUB_DELAY_MS / STUB_IGNORE_SIGTERM
// env vars to keep the contract assertions symmetric.
// ---------------------------------------------------------------------

class FakeCodexThread {
  capturedSignal: AbortSignal | null = null;
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly threadId: string,
  ) {}
  get id(): string {
    return this.threadId;
  }
  async runStreamed(
    _input: unknown,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.capturedSignal = turnOptions?.signal ?? null;
    const env = this.env;
    const threadId = this.threadId;
    const ignoreSigterm = env.STUB_IGNORE_SIGTERM === '1';
    const delayMs = Number.parseInt(env.STUB_DELAY_MS ?? '0', 10) || 0;
    const verdict = env.STUB_VERDICT;
    const reason = env.STUB_REASON ?? '';
    const events = (async function* (): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: threadId };
      if (delayMs > 0) {
        // Honour STUB_DELAY_MS — yield events only after delay, but
        // remain interruptible by abort. STUB_IGNORE_SIGTERM keeps the
        // generator alive until our adapter's own kill emit fires.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delayMs);
          if (!ignoreSigterm) {
            turnOptions?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          }
        });
        if (turnOptions?.signal?.aborted && !ignoreSigterm) return;
      }
      if (verdict) {
        yield {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: `{"verdict":"${verdict}","reason":"${reason}"}`,
          },
        };
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };
    })();
    return { events };
  }
  async run(_input: unknown): Promise<never> {
    throw new Error('FakeCodexThread.run() not used in tests');
  }
}

class FakeCodex {
  constructor(private readonly env: NodeJS.ProcessEnv) {}
  startThread(_opts?: ThreadOptions): Thread {
    return new FakeCodexThread(this.env, 'fake-codex-start') as unknown as Thread;
  }
  resumeThread(id: string, _opts?: ThreadOptions): Thread {
    return new FakeCodexThread(this.env, id) as unknown as Thread;
  }
}

/** Capture env passed via `CodexOptions.env` so the contract test's
 *  STUB_* vars reach the fake. */
function makeCodexAdapter(binPath: string): CliAgentAdapter {
  return new CodexAdapter({
    binPath,
    codexFactory: (opts) =>
      new FakeCodex(opts.env ?? process.env) as unknown as import('@openai/codex-sdk').Codex,
  });
}

/**
 * L1.T10 — cross-adapter contract suite.
 *
 * Parameterized over all 4 adapters (claude / codex / pi / opencode).
 * Verifies the **uniform CliAgentAdapter contract** holds across
 * fundamentally different CLI implementations:
 *   - claude: single-envelope JSON (one big result on close)
 *   - codex: single-envelope text + Ink-crash detection
 *   - pi: streaming LF-JSONL with rich event types
 *   - opencode: streaming JSON, schema-tolerant mapping
 *
 * Per-adapter detail tests (claude-adapter.test.ts etc.) cover
 * adapter-specific edge cases. This suite proves the SHARED
 * invariants — what every adapter MUST guarantee regardless of CLI.
 *
 * Coverage:
 *   1. spawn() returns a handle with valid sessionId + adapter name
 *   2. event stream produces ≥1 session_start + exactly 1 terminal event
 *   3. cancel mid-run → cancel_requested + terminal error{killed}
 *   4. cancel is idempotent (safe to call twice)
 *   5. getCost() returns non-negative number throughout lifecycle
 *   6. timeout → terminal error{timeout}
 *   7. resume() either returns new handle OR throws AgentResumeUnsupportedError
 *      (each adapter's choice is documented in its JSDoc)
 *
 * What this suite does NOT cover (and why):
 *   - Real-CLI smokes (gated behind RUN_REAL_* env vars in
 *     `cli-agent-smoke-real.test.ts` — out of scope for default CI
 *     since binaries aren't installed)
 *   - Adapter-specific failure modes (Ink-crash, parse_failed, etc.)
 *     — covered in per-adapter test files
 *   - Process safety (lockfile, registry) — covered in
 *     `harness-safety.test.ts`
 *   - Transcript persistence — covered in `transcript.test.ts`
 */

interface AdapterFixture {
  name: string;
  stubFile: string;
  /** Factory that returns the adapter instance given a binPath. */
  factory: (binPath: string) => CliAgentAdapter;
  /** Whether `resume()` is expected to succeed (claude/pi/opencode)
   *  or throw `AgentResumeUnsupportedError` (codex 0.1.x). */
  resumeSupported: boolean;
  /** Env vars to pass to the stub for the happy-path test (chosen
   *  to ensure the stub completes quickly). */
  happyEnv: Record<string, string>;
  /** Env vars to make the stub hang long enough for cancel/timeout
   *  tests to reliably interrupt it. */
  delayEnv: Record<string, string>;
}

const ADAPTERS: AdapterFixture[] = [
  {
    name: 'claude',
    stubFile: 'claude-stub.cjs',
    factory: (binPath) => new ClaudeAdapter({ binPath }),
    resumeSupported: true,
    happyEnv: { STUB_RESULT: 'cross-test ok', STUB_COST: '0.01' },
    delayEnv: { STUB_DELAY_MS: '5000' },
  },
  {
    name: 'codex',
    // Stub file is reused only to give the adapter a real binPath; the
    // FakeCodex injected via codexFactory bypasses the bash wrapper.
    stubFile: 'codex-stub.cjs',
    factory: makeCodexAdapter,
    // SDK migration (2026-05-16) — `resumeThread` is real now.
    resumeSupported: true,
    happyEnv: { STUB_VERDICT: 'approve', STUB_REASON: 'cross-test ok' },
    delayEnv: { STUB_DELAY_MS: '5000' },
  },
  {
    name: 'pi',
    stubFile: 'pi-stub.cjs',
    factory: (binPath) => new PiAdapter({ binPath }),
    resumeSupported: true,
    happyEnv: { STUB_SUMMARY: 'cross-test ok' },
    delayEnv: { STUB_DELAY_MS: '5000' },
  },
  {
    name: 'opencode',
    stubFile: 'opencode-stub.cjs',
    factory: (binPath) => new OpencodeAdapter({ binPath }),
    resumeSupported: true,
    happyEnv: { STUB_SUMMARY: 'cross-test ok' },
    delayEnv: { STUB_DELAY_MS: '5000' },
  },
];

function makeStubWrapper(stubFile: string): {
  binPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), `morion-cross-stub-`));
  const wrapper = join(dir, 'agent-bin');
  const stubPath = join(__dirname, 'fixtures', stubFile);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${stubPath}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return {
    binPath: wrapper,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function collectEvents(handle: AgentHandle): Promise<CliAgentEvent[]> {
  const out: CliAgentEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

describe.each(ADAPTERS)('CliAgentAdapter contract: $name', ({
  name,
  stubFile,
  factory,
  resumeSupported,
  happyEnv,
  delayEnv,
}) => {
  let stub: ReturnType<typeof makeStubWrapper>;
  let workDir: string;

  beforeEach(() => {
    stub = makeStubWrapper(stubFile);
    workDir = mkdtempSync(join(tmpdir(), `morion-cross-cwd-`));
  });
  afterEach(() => {
    stub.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('spawn returns handle with sessionId + adapter name + pid', async () => {
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'cross-test',
      cwd: workDir,
      env: happyEnv,
    });
    expect(handle.adapter).toBe(name);
    expect(typeof handle.sessionId).toBe('string');
    expect(handle.sessionId.length).toBeGreaterThan(0);
    // pid is non-null for adapters that spawn the CLI directly. SDK-
    // driven adapters (codex post-2026-05-16) abstract the child away
    // and surface pid=null — documented in their JSDoc. Accept either.
    if (handle.pid !== null) {
      expect(handle.pid).toBeGreaterThan(0);
    }
    await collectEvents(handle); // drain to clean up
  });

  it('event stream produces ≥1 session_start + exactly 1 terminal event', async () => {
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'cross-test',
      cwd: workDir,
      env: happyEnv,
    });
    const events = await collectEvents(handle);

    const sessionStarts = events.filter(isSessionStart);
    expect(sessionStarts.length).toBeGreaterThanOrEqual(1);

    const terminals = events.filter(isTerminalEvent);
    expect(terminals).toHaveLength(1);
  });

  it('cancel mid-run → cancel_requested + terminal error{killed}', async () => {
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'cross-test',
      cwd: workDir,
      env: delayEnv,
    });
    setTimeout(() => void handle.cancel('cross_test_cancel'), 80);
    const events = await collectEvents(handle);

    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    expect(cancelEv).toBeDefined();
    if (cancelEv?.kind === 'cancel_requested') {
      expect(cancelEv.reason).toBe('cross_test_cancel');
    }

    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('killed');
    }
  });

  it('cancel is idempotent (safe to call twice)', async () => {
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: workDir,
      env: delayEnv,
    });
    const drain = collectEvents(handle);
    setTimeout(() => void handle.cancel('first'), 50);
    setTimeout(() => void handle.cancel('second'), 100);
    await drain;
    // No throw → idempotent.
    expect(true).toBe(true);
  });

  it('getCost() returns non-negative number throughout lifecycle', async () => {
    const adapter = factory(stub.binPath);
    expect(() => factory(stub.binPath)).not.toThrow();
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: workDir,
      env: happyEnv,
    });
    expect(handle.getCost()).toBeGreaterThanOrEqual(0);
    await collectEvents(handle);
    expect(handle.getCost()).toBeGreaterThanOrEqual(0);
  });

  it('timeout → terminal error{timeout}', async () => {
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: workDir,
      timeoutMs: 200,
      env: delayEnv,
    });
    const events = await collectEvents(handle);
    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    if (cancelEv?.kind === 'cancel_requested') {
      expect(cancelEv.reason).toBe('timeout');
    }
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('timeout');
    }
  });

  if (resumeSupported) {
    it('resume() returns a new handle (resume-supported adapters)', async () => {
      const adapter = factory(stub.binPath);
      const handle = await adapter.spawn({
        prompt: 'first',
        cwd: workDir,
        env: happyEnv,
      });
      await collectEvents(handle);
      // Codex T10 review P1: streaming adapters need `exited`
      // before resume — guard ensures prior child has released
      // worktree lockfile + transcript fd.
      await handle.exited;
      const resumed = await handle.resume('continue');
      expect(resumed.adapter).toBe(name);
      expect(typeof resumed.sessionId).toBe('string');
      await collectEvents(resumed);
      await resumed.exited;
    });
  } else {
    it('resume() throws AgentResumeUnsupportedError', async () => {
      const adapter = factory(stub.binPath);
      const handle = await adapter.spawn({
        prompt: 'first',
        cwd: workDir,
        env: happyEnv,
      });
      await collectEvents(handle);
      await expect(handle.resume('continue')).rejects.toBeInstanceOf(
        AgentResumeUnsupportedError,
      );
    });
  }

  it('SIGKILL escalation: cancel kills agent that ignores SIGTERM', async () => {
    // All four stubs honor STUB_IGNORE_SIGTERM. This test catches
    // any future regression in the AbstractAgentHandle SIGKILL chain
    // that would let a stubborn agent hang past cancel.
    const adapter = factory(stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: workDir,
      env: { ...delayEnv, STUB_IGNORE_SIGTERM: '1', STUB_DELAY_MS: '60000' },
    });
    const t0 = Date.now();
    setTimeout(() => void handle.cancel('cross_sigkill_test'), 50);
    await collectEvents(handle);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});

// ---------------------------------------------------------------------
// Cross-cutting verifications (not per-adapter)
// ---------------------------------------------------------------------

describe('Cross-adapter sanity (L1.T10)', () => {
  it('all 4 adapters export distinct AgentName values', () => {
    const names = ADAPTERS.map((a) => {
      const stub = makeStubWrapper(a.stubFile);
      try {
        return a.factory(stub.binPath).name;
      } finally {
        stub.cleanup();
      }
    });
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual(['claude', 'codex', 'pi', 'opencode']);
  });

  it('adapter `name` field matches AgentHandle.adapter after spawn', async () => {
    for (const a of ADAPTERS) {
      const stub = makeStubWrapper(a.stubFile);
      const workDir = mkdtempSync(join(tmpdir(), 'morion-cross-name-'));
      try {
        const adapter = a.factory(stub.binPath);
        const handle = await adapter.spawn({
          prompt: 'x',
          cwd: workDir,
          env: a.happyEnv,
        });
        expect(handle.adapter).toBe(adapter.name);
        await collectEvents(handle);
      } finally {
        stub.cleanup();
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });
});
