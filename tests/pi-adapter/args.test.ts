import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync } from 'node:fs';
import { PiAdapter } from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  readArgsLog,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/pi-adapter-setup.js';

describe('PiAdapter — args propagation', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('passes -p --mode json --tools <mapped> + prompt; OMITS --session on fresh run', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'analyse',
      cwd: env.workDir,
      sessionId: 'pi-sess-args',
      allowedTools: ['Read', 'Bash', 'Edit'],
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('-p');
    expect(log.args).toContain('--mode');
    expect(log.args).toContain('json');
    expect(log.args).toContain('--tools');
    // Mapped: Read→read, Bash→bash, Edit→edit
    expect(log.args).toContain('read,bash,edit');
    expect(log.args).toContain('analyse');
    expect(realpathSync(log.cwd)).toBe(realpathSync(env.workDir));
    // Codex T5 review P1: pi `--session <id>` semantics on fresh
    // runs is risky without real-pi verification — pi may treat it
    // as "resume non-existent session". Adapter omits --session on
    // fresh; pi assigns its own id (captured from the `session`
    // event in stream + used on resume).
    expect(log.args).not.toContain('--session');
  });

  it('passes --provider when agentConfig.provider set', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      agentConfig: { provider: 'ollama' },
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('--provider');
    expect(log.args).toContain('ollama');
  });

  it('passes --model when set', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      model: 'qwen-coder',
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('--model');
    expect(log.args).toContain('qwen-coder');
  });

  it('uses default tool allowlist when allowedTools not provided', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    // Default = Read,Write,Edit,Glob,Grep,Bash → read,write,edit,find,grep,bash
    expect(log.args).toContain('read,write,edit,find,grep,bash');
  });
});
