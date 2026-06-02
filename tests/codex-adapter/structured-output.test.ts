import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isResult,
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

describe('CodexAdapter — structured output', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('forwards agentConfig.outputSchema to SDK TurnOptions', async () => {
    let thread: FakeThread | null = null;
    const verdictSchema = {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'reopen', 'escalate'] },
        reason: { type: 'string' },
      },
      required: ['verdict', 'reason'],
    } as const;
    const { adapter } = makeFakeAdapter(() => {
      thread = new FakeThread(null, [
        { type: 'thread.started', thread_id: 't-struct-1' },
        {
          type: 'item.completed',
          item: {
            id: 'm-1',
            type: 'agent_message',
            text: '{"verdict":"approve","reason":"diff looks correct"}',
          },
        },
      ]);
      return thread;
    }, env.stub.binPath);

    const handle = await adapter.spawn({
      prompt: 'review',
      cwd: env.workDir,
      agentConfig: { outputSchema: verdictSchema },
    });
    const events = await collectEvents(handle);

    expect(thread!.calls[0]?.turnOptions?.outputSchema).toEqual(verdictSchema);
    const terminal = events.find(isTerminalEvent)!;
    expect(isResult(terminal)).toBe(true);
    if (isResult(terminal)) {
      // Summary is the parsed-JSON text — workflow runner parses
      // without regex.
      expect(JSON.parse(terminal.summary)).toEqual({
        verdict: 'approve',
        reason: 'diff looks correct',
      });
    }
  });

  it('omits outputSchema when agentConfig is empty', async () => {
    let thread: FakeThread | null = null;
    const { adapter } = makeFakeAdapter(() => {
      thread = new FakeThread(null, [
        { type: 'thread.started', thread_id: 't-1' },
        {
          type: 'item.completed',
          item: { id: 'm-1', type: 'agent_message', text: 'ok' },
        },
      ]);
      return thread;
    }, env.stub.binPath);
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    await collectEvents(handle);
    expect(thread!.calls[0]?.turnOptions?.outputSchema).toBeUndefined();
  });
});
