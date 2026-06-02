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

/**
 * Shared fixture for the PiAdapter scenario suites under
 * `tests/pi-adapter/`. Same pattern as `claude-adapter-setup.ts` +
 * `opencode-adapter-setup.ts`. The pi-stub fixture lives at
 * `tests/fixtures/pi-stub.cjs`; tests pass STUB_* vars via
 * `SpawnOptions.env` (NOT `process.env`) so concurrent tests don't
 * interfere.
 */

const STUB_PATH = join(__dirname, '..', 'fixtures', 'pi-stub.cjs');

export function makeStubWrapper(): { binPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'morion-pi-adapter-stub-'));
  const wrapper = join(dir, 'pi');
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

export async function collectEvents(handle: AgentHandle): Promise<CliAgentEvent[]> {
  const out: CliAgentEvent[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

export interface TestEnv {
  stub: ReturnType<typeof makeStubWrapper>;
  workDir: string;
  argsLogPath: string;
}

export function setup(): TestEnv {
  const stub = makeStubWrapper();
  const workDir = mkdtempSync(join(tmpdir(), 'morion-pi-adapter-cwd-'));
  const argsLogPath = join(workDir, 'argv.json');
  return { stub, workDir, argsLogPath };
}

export function teardown(env: TestEnv): void {
  env.stub.cleanup();
  rmSync(env.workDir, { recursive: true, force: true });
}

export function readArgsLog(env: TestEnv): { args: string[]; cwd: string } {
  return JSON.parse(readFileSync(env.argsLogPath, 'utf8'));
}
