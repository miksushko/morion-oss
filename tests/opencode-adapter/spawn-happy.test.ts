import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  OpencodeAdapter,
  isError,
  isResult,
  isSessionStart,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  setupOpencodeEnv,
  teardownOpencodeEnv,
  type OpencodeTestEnv,
} from '../helpers/opencode-adapter-setup.js';

/**
 * OpencodeAdapter (L1.T6) — happy path + fallback paths.
 *
 * Schema reference: real opencode `--format json` events
 * (verified 2026-05-09 via takopi cheatsheet, Codex T10 review P1
 * fix). 5 event types in production:
 *   - step_start (sessionID, part.snapshot)
 *   - tool_use (part.{tool, state.{status, input, output, time}})
 *   - text (part.text)
 *   - step_finish (part.{reason, cost, tokens})
 *   - error (error.{name, data.message})
 */

describe('OpencodeAdapter — happy path', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('emits session_start (from step_start) + text_delta + result (from step_finish)', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'do the thing',
      cwd: env.workDir,
      env: {
        STUB_SUMMARY: 'opencode delivers',
        STUB_COST: '0.001',
      },
    });

    expect(handle.adapter).toBe('opencode');

    const events = await collectEvents(handle);
    const sessionStarts = events.filter(isSessionStart);
    expect(sessionStarts.length).toBeGreaterThanOrEqual(1);
    expect(sessionStarts.every((e) => e.agent === 'opencode')).toBe(true);

    // text event from `text` opencode event
    const textDelta = events.find((e) => e.kind === 'text_delta');
    expect(textDelta).toBeDefined();
    if (textDelta?.kind === 'text_delta') {
      expect(textDelta.text).toBe('opencode delivers');
    }

    const result = events.find(isResult)!;
    expect(result.terminalReason).toBe('completed');
    expect(result.costUsd).toBeCloseTo(0.001);
  });

  it('streams tool_end with input/output/durationMs from tool_use event', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const toolCalls = [
      { id: 't1', name: 'bash', input: { cmd: 'ls' }, output: 'a\nb' },
    ];
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_TOOL_CALLS: JSON.stringify(toolCalls) },
    });
    const events = await collectEvents(handle);

    // opencode emits ONE tool_use per tool — adapter maps to tool_end.
    const ends = events.filter((e) => e.kind === 'tool_end');
    expect(ends).toHaveLength(1);
    if (ends[0]?.kind === 'tool_end') {
      expect(ends[0].toolName).toBe('bash');
      expect(ends[0].result).toBe('a\nb');
      // durationMs computed from part.state.time.{start,end}
      expect(ends[0].durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports cost from step_finish.part.cost', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_COST: '0.0234' },
    });
    const events = await collectEvents(handle);
    const result = events.find(isResult)!;
    expect(result.costUsd).toBeCloseTo(0.0234);
    expect(handle.getCost()).toBeCloseTo(0.0234);
  });
});

describe('OpencodeAdapter — fallback paths', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('single-envelope step_finish output → still parses + emits result', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_SINGLE_ENVELOPE: '1',
        STUB_COST: '0.005',
      },
    });
    const events = await collectEvents(handle);
    const result = events.find(isResult);
    expect(result).toBeDefined();
    if (result) {
      expect(result.costUsd).toBeCloseTo(0.005);
    }
  });

  it('clean exit without terminal step_finish → result with stdout summary', async () => {
    // Defensive fallback: opencode emits text but never step_finish
    // with reason='stop'. Adapter falls back to stdout-as-summary
    // so workflow runner has SOMETHING to log.
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_NO_TERMINAL: '1' },
    });
    const events = await collectEvents(handle);
    const result = events.find(isResult);
    expect(result).toBeDefined();
  });

  it('error event in stream → error{non_zero_exit}', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_EMIT_ERROR: '1' },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('non_zero_exit');
      // Real opencode error.data.message lifted into our message field.
      expect(terminal.message).toContain('opencode failed mid-run');
    }
  });

  it('non-zero exit → error{non_zero_exit}', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_EXIT_CODE: '5', STUB_STDERR: 'boom\n' },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('non_zero_exit');
      expect(terminal.message).toContain('boom');
    }
  });
});
