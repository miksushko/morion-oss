import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CodexOptions,
  Thread,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from '@openai/codex-sdk';
import {
  CodexAdapter,
  type AgentHandle,
  type CliAgentEvent,
} from '../../src/core/auto-code/harness/index.js';

/**
 * Shared fixture for the CodexAdapter (SDK edition) scenario suites
 * under `tests/codex-adapter/`. Uses `@openai/codex-sdk`'s injection
 * seam via `codexFactory` instead of bash-stubbing the codex CLI —
 * the SDK owns the JSONL event protocol + child lifecycle, so tests
 * plug in a FakeCodex that yields the exact ThreadEvent stream they
 * need. Extracted from `tests/codex-adapter.test.ts` (2026-05-16,
 * ticket `01KRR8FAQN941JRBAX005TMV2R`).
 */

export interface FakeThreadCall {
  prompt: string;
  turnOptions: TurnOptions | undefined;
}

export interface FakeCodexCall {
  threadOptions: ThreadOptions | undefined;
  kind: 'start' | 'resume';
  resumeId?: string;
}

export class FakeThread implements Thread {
  /** @internal */ _id: string | null;
  calls: FakeThreadCall[] = [];
  yields: ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>);
  /** When set, runStreamed throws this synchronously. */
  throwOnRun: Error | null = null;
  /** When set, runStreamed delays before resolving — lets cancel /
   *  timeout reliably interrupt. */
  delayBeforeResolveMs = 0;
  /** Captures the AbortSignal so tests can assert abort() was called. */
  capturedSignal: AbortSignal | null = null;

  constructor(
    id: string | null,
    yields: ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>),
  ) {
    this._id = id;
    this.yields = yields;
  }

  get id(): string | null {
    return this._id;
  }

  async runStreamed(
    input: string | unknown,
    turnOptions?: TurnOptions,
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.calls.push({
      prompt: typeof input === 'string' ? input : JSON.stringify(input),
      turnOptions,
    });
    this.capturedSignal = turnOptions?.signal ?? null;
    if (this.delayBeforeResolveMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayBeforeResolveMs));
    }
    if (this.throwOnRun) throw this.throwOnRun;
    const yieldsRef = this.yields;
    const gen = (async function* (): AsyncGenerator<ThreadEvent> {
      if (typeof yieldsRef === 'function') {
        for await (const ev of yieldsRef()) yield ev;
      } else {
        for (const ev of yieldsRef) yield ev;
      }
    })();
    return { events: gen };
  }

  async run(input: string | unknown, turnOptions?: TurnOptions): Promise<never> {
    void input;
    void turnOptions;
    throw new Error('FakeThread.run() not used in tests');
  }
}

export class FakeCodex {
  calls: FakeCodexCall[] = [];
  threadFactory: (
    options?: ThreadOptions,
    kind?: 'start' | 'resume',
    resumeId?: string,
  ) => FakeThread;

  constructor(
    threadFactory: FakeCodex['threadFactory'] = () =>
      new FakeThread('thread-fake', []),
  ) {
    this.threadFactory = threadFactory;
  }

  startThread(options?: ThreadOptions): Thread {
    this.calls.push({ threadOptions: options, kind: 'start' });
    return this.threadFactory(options, 'start') as unknown as Thread;
  }

  resumeThread(id: string, options?: ThreadOptions): Thread {
    this.calls.push({ threadOptions: options, kind: 'resume', resumeId: id });
    return this.threadFactory(options, 'resume', id) as unknown as Thread;
  }
}

export interface FakeAdapterCapture {
  codex: FakeCodex | null;
  codexOptions: CodexOptions | null;
}

/** Build a CodexAdapter wired to a FakeCodex factory whose `Codex`
 *  instance is captured for inspection. */
export function makeFakeAdapter(
  threadBuilder: FakeCodex['threadFactory'],
  binPath: string,
): { adapter: CodexAdapter; capture: FakeAdapterCapture } {
  const capture: FakeAdapterCapture = {
    codex: null,
    codexOptions: null,
  };
  const adapter = new CodexAdapter({
    binPath,
    codexFactory: (opts) => {
      capture.codexOptions = opts;
      const codex = new FakeCodex(threadBuilder);
      capture.codex = codex;
      return codex as unknown as import('@openai/codex-sdk').Codex;
    },
  });
  return { adapter, capture };
}

export async function collectEvents(handle: AgentHandle): Promise<CliAgentEvent[]> {
  const out: CliAgentEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

/** Make a real-looking binary path the adapter's `existsSync` check
 *  accepts (we pass a `chmod 755` empty file). The SDK never actually
 *  invokes it because we inject the FakeCodex. */
export function makeBinStub(): { binPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'morion-codex-sdk-stub-'));
  const wrapper = join(dir, 'codex');
  writeFileSync(wrapper, '#!/bin/sh\nexit 0\n');
  chmodSync(wrapper, 0o755);
  return {
    binPath: wrapper,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface CodexTestEnv {
  stub: ReturnType<typeof makeBinStub>;
  workDir: string;
}

export function setup(): CodexTestEnv {
  const stub = makeBinStub();
  const workDir = mkdtempSync(join(tmpdir(), 'morion-codex-sdk-cwd-'));
  return { stub, workDir };
}

export function teardown(env: CodexTestEnv): void {
  env.stub.cleanup();
  rmSync(env.workDir, { recursive: true, force: true });
}
