import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PiAdapter,
  isResult,
  isSessionStart,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/pi-adapter-setup.js';

describe('PiAdapter — happy path', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('emits session_start + message + result on clean run', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'do the task',
      cwd: env.workDir,
      sessionId: 'pi-sess-1',
      env: { STUB_SUMMARY: 'task done with grace' },
    });

    expect(handle.adapter).toBe('pi');
    expect(handle.sessionId).toBe('pi-sess-1');

    const events = await collectEvents(handle);

    // Base class emits session_start synthetically; pi's `session`
    // line emits a SECOND session_start with pi's authoritative
    // id (matches our pre-allocated id when we passed --session).
    const sessionStarts = events.filter(isSessionStart);
    expect(sessionStarts.length).toBeGreaterThanOrEqual(1);
    expect(sessionStarts.every((e) => e.agent === 'pi')).toBe(true);

    // Message event from message_end
    const messageEv = events.find((e) => e.kind === 'message');
    expect(messageEv).toBeDefined();
    if (messageEv?.kind === 'message') {
      expect(messageEv.role).toBe('assistant');
      expect(messageEv.content).toBe('task done with grace');
    }

    // Terminal result from agent_end
    const result = events.find(isResult)!;
    expect(result).toBeDefined();
    expect(result.terminalReason).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0); // pi 0.x doesn't surface cost
    expect(result.summary).toBe('task done with grace');
  });

  it('handles message.content as array of blocks', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_SUMMARY: 'block-shaped content',
        STUB_MESSAGE_CONTENT_FORMAT: 'blocks',
      },
    });
    const events = await collectEvents(handle);
    const messageEv = events.find((e) => e.kind === 'message');
    if (messageEv?.kind === 'message') {
      expect(messageEv.content).toBe('block-shaped content');
    }
  });

  it('streams tool_start + tool_end with computed durationMs', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const toolCalls = [
      {
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: '/tmp/x' },
        result: 'file contents',
      },
      {
        toolCallId: 'call-2',
        toolName: 'bash',
        args: { cmd: 'ls' },
        result: 'a\nb\nc',
      },
    ];
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_TOOL_CALLS: JSON.stringify(toolCalls) },
    });
    const events = await collectEvents(handle);

    const toolStarts = events.filter((e) => e.kind === 'tool_start');
    const toolEnds = events.filter((e) => e.kind === 'tool_end');
    expect(toolStarts).toHaveLength(2);
    expect(toolEnds).toHaveLength(2);

    if (toolStarts[0]?.kind === 'tool_start') {
      expect(toolStarts[0].toolName).toBe('read');
    }
    if (toolEnds[0]?.kind === 'tool_end') {
      expect(toolEnds[0].toolName).toBe('read');
      expect(toolEnds[0].result).toBe('file contents');
      expect(toolEnds[0].durationMs).toBeGreaterThanOrEqual(0);
    }

    // tool events arrive BEFORE the terminal result.
    const toolStartIdx = events.findIndex((e) => e.kind === 'tool_start');
    const resultIdx = events.findIndex(isResult);
    expect(toolStartIdx).toBeLessThan(resultIdx);
  });

  it('skips non-JSON garbage interleaved in stream', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_INTERLEAVE_GARBAGE: '1' },
    });
    // Should not throw + still produce a result
    const events = await collectEvents(handle);
    expect(events.find(isResult)).toBeDefined();
  });
});
