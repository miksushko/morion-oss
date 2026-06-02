import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSessionStart } from '../../src/core/auto-code/harness/index.js';
import {
  FakeThread,
  collectEvents,
  makeFakeAdapter,
  setup,
  teardown,
  type CodexTestEnv,
  type FakeCodexCall,
} from '../helpers/codex-adapter-setup.js';

describe('CodexAdapter — resume', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('routes SpawnOptions.resumeSessionId through Codex.resumeThread', async () => {
    const { adapter, capture } = makeFakeAdapter(
      (opts, kind, resumeId) => {
        void opts;
        const id = kind === 'resume' ? (resumeId ?? null) : null;
        return new FakeThread(null, [
          { type: 'thread.started', thread_id: id ?? 'fallback' },
          {
            type: 'item.completed',
            item: { id: 'm-1', type: 'agent_message', text: 'resumed ok' },
          },
        ]);
      },
      env.stub.binPath,
    );
    const handle = await adapter.spawn({
      prompt: 'continue',
      cwd: env.workDir,
      resumeSessionId: 'thread-prior-1',
    });
    const events = await collectEvents(handle);
    expect(capture.codex?.calls[0]?.kind).toBe('resume');
    expect(capture.codex?.calls[0]?.resumeId).toBe('thread-prior-1');
    const start = events.find(isSessionStart)!;
    if (isSessionStart(start)) {
      expect(start.sessionId).toBe('thread-prior-1');
    }
  });

  it('handle.resume() opens a fresh thread on the same id', async () => {
    const openedKinds: FakeCodexCall['kind'][] = [];
    const { adapter } = makeFakeAdapter(
      (opts, kind, resumeId) => {
        void opts;
        openedKinds.push(kind ?? 'start');
        const id = kind === 'resume' ? resumeId ?? 't-final' : 't-fresh';
        return new FakeThread(null, [
          { type: 'thread.started', thread_id: id },
          {
            type: 'item.completed',
            item: { id: 'm', type: 'agent_message', text: 'ok' },
          },
        ]);
      },
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    await collectEvents(handle);
    await handle.exited;
    const resumed = await handle.resume('keep going');
    expect(resumed.adapter).toBe('codex');
    await collectEvents(resumed);
    await resumed.exited;
    expect(openedKinds).toEqual(['start', 'resume']);
  });
});
