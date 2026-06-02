import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentHandle,
  CliAgentEvent,
} from '../../src/core/auto-code/harness/index.js';

const STUB_PATH = join(__dirname, '..', 'fixtures', 'opencode-stub.cjs');

export function makeStubWrapper(): { binPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'morion-opencode-adapter-stub-'));
  const wrapper = join(dir, 'opencode');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${STUB_PATH}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return {
    binPath: wrapper,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function collectEvents(
  handle: AgentHandle,
): Promise<CliAgentEvent[]> {
  const out: CliAgentEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

export interface OpencodeTestEnv {
  stub: ReturnType<typeof makeStubWrapper>;
  workDir: string;
  argsLogPath: string;
}

export function setupOpencodeEnv(): OpencodeTestEnv {
  const stub = makeStubWrapper();
  const workDir = mkdtempSync(join(tmpdir(), 'morion-opencode-adapter-cwd-'));
  const argsLogPath = join(workDir, 'argv.json');
  return { stub, workDir, argsLogPath };
}

export function teardownOpencodeEnv(env: OpencodeTestEnv): void {
  env.stub.cleanup();
  rmSync(env.workDir, { recursive: true, force: true });
}

export function readArgsLog(env: OpencodeTestEnv): {
  args: string[];
  cwd: string;
} {
  return JSON.parse(readFileSync(env.argsLogPath, 'utf8'));
}
