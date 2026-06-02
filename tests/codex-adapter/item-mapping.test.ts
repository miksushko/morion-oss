import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FakeThread,
  collectEvents,
  makeFakeAdapter,
  setup,
  teardown,
  type CodexTestEnv,
} from '../helpers/codex-adapter-setup.js';

describe('CodexAdapter — SDK item mapping', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('command_execution → tool_start + tool_end with bash', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 't-tool-1' },
          {
            type: 'item.started',
            item: {
              id: 'cmd-1',
              type: 'command_execution',
              command: 'cat README.md',
              aggregated_output: '',
              status: 'in_progress',
            },
          },
          {
            type: 'item.completed',
            item: {
              id: 'cmd-1',
              type: 'command_execution',
              command: 'cat README.md',
              aggregated_output: '# Hello\n',
              exit_code: 0,
              status: 'completed',
            },
          },
          {
            type: 'item.completed',
            item: { id: 'msg-1', type: 'agent_message', text: 'done' },
          },
        ]),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const events = await collectEvents(handle);
    const start = events.find(
      (e) => e.kind === 'tool_start' && e.toolName === 'bash',
    );
    const end = events.find(
      (e) => e.kind === 'tool_end' && e.toolName === 'bash',
    );
    expect(start).toBeDefined();
    expect(end).toBeDefined();
  });

  it('file_change → tool_start + tool_end with apply_patch', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 't-fc-1' },
          {
            type: 'item.started',
            item: {
              id: 'fc-1',
              type: 'file_change',
              changes: [{ path: 'a.ts', kind: 'update' }],
              status: 'completed',
            },
          },
          {
            type: 'item.completed',
            item: {
              id: 'fc-1',
              type: 'file_change',
              changes: [{ path: 'a.ts', kind: 'update' }],
              status: 'completed',
            },
          },
          {
            type: 'item.completed',
            item: { id: 'msg-1', type: 'agent_message', text: 'patched' },
          },
        ]),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const events = await collectEvents(handle);
    const start = events.find(
      (e) => e.kind === 'tool_start' && e.toolName === 'apply_patch',
    );
    const end = events.find(
      (e) => e.kind === 'tool_end' && e.toolName === 'apply_patch',
    );
    expect(start).toBeDefined();
    expect(end).toBeDefined();
  });
});
