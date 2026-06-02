import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isResult,
  isSessionStart,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  FakeThread,
  collectEvents,
  makeFakeAdapter,
  setup,
  teardown,
  type CodexTestEnv,
} from '../helpers/codex-adapter-setup.js';

describe('CodexAdapter (SDK edition) — happy path', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('emits session_start + message + result with agent_message text as summary', async () => {
    const { adapter, capture } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 'thread-happy-1' },
          { type: 'turn.started' },
          {
            type: 'item.completed',
            item: {
              id: 'msg-1',
              type: 'agent_message',
              text: 'I reviewed the diff and it looks correct.',
            },
          },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
            },
          },
        ]),
      env.stub.binPath,
    );

    const handle = await adapter.spawn({
      prompt: 'review this diff',
      cwd: env.workDir,
    });
    expect(handle.adapter).toBe('codex');
    // PID is null for SDK-driven runs — the SDK owns the child.
    expect(handle.pid).toBeNull();

    const events = await collectEvents(handle);
    const start = events[0]!;
    expect(isSessionStart(start)).toBe(true);
    if (isSessionStart(start)) {
      expect(start.agent).toBe('codex');
      expect(start.sessionId).toBe('thread-happy-1');
    }
    expect(handle.sessionId).toBe('thread-happy-1');

    const message = events.find((e) => e.kind === 'message');
    expect(message?.kind).toBe('message');

    const terminal = events.find(isTerminalEvent)!;
    expect(isResult(terminal)).toBe(true);
    if (isResult(terminal)) {
      expect(terminal.summary).toBe('I reviewed the diff and it looks correct.');
      expect(terminal.exitCode).toBe(0);
      expect(terminal.terminalReason).toBe('completed');
      expect(terminal.costUsd).toBe(0);
    }
    expect(handle.getCost()).toBe(0);

    // Codex SDK options propagated.
    expect(capture.codexOptions?.codexPathOverride).toBe(env.stub.binPath);
    expect(capture.codex?.calls[0]?.kind).toBe('start');
    const threadOptions = capture.codex?.calls[0]?.threadOptions;
    expect(threadOptions?.workingDirectory).toBe(env.workDir);
    expect(threadOptions?.skipGitRepoCheck).toBe(true);
    expect(threadOptions?.approvalPolicy).toBe('never');
    expect(threadOptions?.sandboxMode).toBe('workspace-write');
  });

  it('forwards model + level to ThreadOptions when set', async () => {
    const { adapter, capture } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 't-1' },
          {
            type: 'item.completed',
            item: { id: 'm-1', type: 'agent_message', text: 'ok' },
          },
        ]),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      model: 'gpt-5',
      level: 'High',
    });
    await collectEvents(handle);
    const threadOptions = capture.codex?.calls[0]?.threadOptions;
    expect(threadOptions?.model).toBe('gpt-5');
    expect(threadOptions?.modelReasoningEffort).toBe('high');
  });

  it('passes the user prompt verbatim to Thread.runStreamed', async () => {
    let thread: FakeThread | null = null;
    const { adapter } = makeFakeAdapter((opts, kind) => {
      void opts;
      void kind;
      thread = new FakeThread(null, [
        { type: 'thread.started', thread_id: 't-1' },
        {
          type: 'item.completed',
          item: { id: 'm-1', type: 'agent_message', text: 'ok' },
        },
      ]);
      return thread;
    }, env.stub.binPath);
    const handle = await adapter.spawn({
      prompt: 'please review the patch',
      cwd: env.workDir,
    });
    await collectEvents(handle);
    expect(thread).not.toBeNull();
    expect(thread!.calls[0]?.prompt).toBe('please review the patch');
  });
});
