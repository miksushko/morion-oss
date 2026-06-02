/**
 * Auto-code harness — shared utilities for adapter implementations.
 * Internal to the harness; not exported from `index.ts`.
 */

import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { AgentBinaryNotFoundError } from './adapter.js';
import type { AgentName } from './events.js';

const execFile = promisify(execFileCb);

/**
 * Locate an agent CLI binary. Resolution order:
 *
 *   1. `MORION_<AGENT>_BIN` env var (uppercase agent name). When set,
 *      the value is used verbatim if the file exists. Useful for
 *      tests + non-standard installs.
 *   2. `which <defaultBinName>` on PATH.
 *
 * Throws `AgentBinaryNotFoundError` listing every path consulted so
 * UI can surface a clear "where to install / how to point at it"
 * message.
 */
export async function resolveAgentBinary(
  agent: AgentName,
  defaultBinName: string,
): Promise<string> {
  const envKey = `MORION_${agent.toUpperCase()}_BIN`;
  const lookedAt: string[] = [];

  const envBin = process.env[envKey];
  if (envBin) {
    lookedAt.push(`$${envKey}=${envBin}`);
    if (existsSync(envBin)) return envBin;
  }

  lookedAt.push(`PATH (${defaultBinName})`);
  try {
    const r = await execFile('which', [defaultBinName], { timeout: 5_000 });
    const path = r.stdout.trim();
    if (path && existsSync(path)) return path;
  } catch {
    // `which` exits non-zero when not found.
  }

  throw new AgentBinaryNotFoundError(agent, lookedAt);
}

/** RFC 4122 v4 UUID using crypto.randomBytes. */
export function generateSessionId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
