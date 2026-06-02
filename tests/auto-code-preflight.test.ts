import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _findOnPathForTest,
  detectClaudeBin,
  detectCodexBin,
  detectMorionMcpInClaude,
  detectMorionMcpInCodex,
  runPreflight,
} from '../src/core/auto-code/preflight.js';

/**
 * Auto-code Phase 1 — preflight detector
 * (sub-ticket 01KQEEARKNH9TE8D008WAX7PQ7).
 *
 * The detector is mostly fs-driven and reads files in the user's
 * HOME by default. Tests inject `preferPath` for binary detection
 * + manipulate $HOME for the config / skill checks. The HTTP route
 * + UI smoke happen in concierge-http.test.ts and a manual browser
 * pass respectively.
 */

describe('preflight — binary detection', () => {
  it('returns ready=true when preferPath points at a runnable executable', () => {
    // Use the running Node binary as the probe target — `node --version`
    // exits 0 on every platform. (`/bin/sh --version` is not portable: it's
    // bash on macOS but dash on most Linux, and dash errors on `--version`,
    // which is what tripped the open-source CI on ubuntu.)
    const result = detectClaudeBin({ preferPath: process.execPath });
    expect(result.ready).toBe(true);
    expect(result.path).toBe(process.execPath);
    expect(result.source).toBe('path');
    expect(result.error).toBeNull();
  });

  it('returns ready=false with an error when preferPath does not exist (PATH/vscode/desktop also empty)', () => {
    // Nothing exists at this path → detector falls through to PATH
    // search → typical CI env doesn't have a `claude` on PATH → no
    // candidate runs → final error message.
    const result = detectClaudeBin({ preferPath: '/tmp/non-existent-binary-path-xyz' });
    if (result.ready) {
      // CI host happens to have claude on PATH — the test still passes
      // the contract; just nothing to assert about the error path.
      expect(result.path).toBeTruthy();
      return;
    }
    expect(result.ready).toBe(false);
    expect(result.error).toContain('Claude');
  });

  it('detectCodexBin without codex on PATH returns ready=false with non-blocking error copy', () => {
    const result = detectCodexBin({ preferPath: '/tmp/non-existent-codex-xyz' });
    if (result.ready) return; // CI host has codex — not the test's concern
    expect(result.ready).toBe(false);
    // Codex is optional → error copy mentions the fallback.
    expect((result.error ?? '').toLowerCase()).toContain('optional');
  });

  // Regression for Morion ticket 01KRRXA0CWNJWBBX21XCFWXZ7E —
  // Tauri-launched sidecar on macOS inherits a minimal launchd PATH
  // (`/usr/bin:/bin:...`) that doesn't include `~/.nvm/.../bin` or
  // `/opt/homebrew/bin`. A `pi` installed via nvm was invisible to
  // the detector, so workflow runs rejected with "pi not installed"
  // even though `which pi` worked fine from the terminal. The fix
  // probes a curated dev-fallback list after the PATH walk misses.
  describe('dev-path fallback for darwin sidecar', () => {
    let prevHome: string | undefined;
    let prevPath: string | undefined;
    let homeDir: string;

    beforeEach(() => {
      prevHome = process.env.HOME;
      prevPath = process.env.PATH;
      homeDir = mkdtempSync(join(tmpdir(), 'morion-preflight-fallback-'));
      process.env.HOME = homeDir;
    });
    afterEach(() => {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevPath !== undefined) process.env.PATH = prevPath;
      else delete process.env.PATH;
      rmSync(homeDir, { recursive: true, force: true });
    });

    it('finds a fake binary in ~/.nvm/versions/node/<latest>/bin via the fallback list (darwin only)', async () => {
      if (process.platform !== 'darwin') return;
      // Minimal launchd-style PATH — none of these dirs match a
      // unique binary name like `morion-fake-bin-*`.
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
      const nvmBin = join(homeDir, '.nvm', 'versions', 'node', 'v25.8.1', 'bin');
      mkdirSync(nvmBin, { recursive: true });
      const fakeBin = 'morion-fake-bin-' + Math.random().toString(36).slice(2, 8);
      const fakePath = join(nvmBin, fakeBin);
      writeFileSync(fakePath, '#!/bin/sh\necho fake\n', { mode: 0o755 });
      const found = _findOnPathForTest(fakeBin);
      expect(found).toBe(fakePath);
    });

    it('finds a fake binary in ~/.local/bin via the fallback list (darwin only)', () => {
      if (process.platform !== 'darwin') return;
      process.env.PATH = '/usr/bin:/bin';
      const localBin = join(homeDir, '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      const fakeBin = 'morion-fake-bin-' + Math.random().toString(36).slice(2, 8);
      const fakePath = join(localBin, fakeBin);
      writeFileSync(fakePath, '#!/bin/sh\necho fake\n', { mode: 0o755 });
      const found = _findOnPathForTest(fakeBin);
      expect(found).toBe(fakePath);
    });

    it('returns null when fake binary is in none of PATH + fallback dirs', () => {
      process.env.PATH = '/usr/bin:/bin';
      // homeDir empty, all fallback dirs miss this unique name.
      const fakeBin = 'morion-not-installed-' + Math.random().toString(36).slice(2, 8);
      const found = _findOnPathForTest(fakeBin);
      expect(found).toBeNull();
    });
  });
});

describe('preflight — Morion MCP detection', () => {
  let prevHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'morion-preflight-home-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('Claude MCP detector returns installed=false on a fresh HOME', () => {
    const result = detectMorionMcpInClaude();
    expect(result.installed).toBe(false);
    expect(result.error).toBeNull();
    expect(result.configPath.endsWith('/.claude.json')).toBe(true);
  });

  it('Claude MCP detector returns installed=true when ~/.claude.json carries our entry', () => {
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          morion: { command: '/usr/local/bin/morion', args: ['mcp'] },
          // Co-tenant entries must be tolerated, not flagged.
          'other-tool': { command: '/usr/local/bin/other', args: [] },
        },
      }),
    );
    const result = detectMorionMcpInClaude();
    expect(result.installed).toBe(true);
    expect(result.error).toBeNull();
  });

  it('Claude MCP detector returns installed=false + non-null error on malformed JSON', () => {
    writeFileSync(join(homeDir, '.claude.json'), '{not valid json,,,');
    const result = detectMorionMcpInClaude();
    expect(result.installed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('Codex MCP detector returns installed=true when ~/.codex/config.toml carries our entry', () => {
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(
      join(homeDir, '.codex', 'config.toml'),
      `
[mcp_servers.morion]
command = "/usr/local/bin/morion"
args = ["mcp"]
`.trim(),
    );
    const result = detectMorionMcpInCodex();
    expect(result.installed).toBe(true);
    expect(result.error).toBeNull();
  });

  it('Codex MCP detector returns installed=false on a fresh HOME', () => {
    const result = detectMorionMcpInCodex();
    expect(result.installed).toBe(false);
    expect(result.error).toBeNull();
  });
});

// Skill detection deliberately omitted — Codex installs skills only at
// project level (no stable user-level path) and the Claude install flow
// lives in sub-ticket 01KQATCMZ5AHY26W1C3M0ZGHG3 (Settings → Skills).
// The UI surfaces a static "manual install" reminder instead of probing
// disk, so there's nothing to test here on the preflight side.

describe('preflight — runPreflight composer', () => {
  let prevHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'morion-preflight-runpf-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('blocking[] populated when Claude binary is absent AND MCP is missing', () => {
    // PATH may have claude on the dev host — this test cares about the
    // shape, not the absence guarantee.
    const result = runPreflight();
    if (!result.claude.ready) {
      expect(result.blocking.some((m) => m.includes('Claude'))).toBe(true);
    }
    if (!result.mcp.claude.installed) {
      expect(result.blocking.some((m) => m.toLowerCase().includes('mcp') || m.toLowerCase().includes('claude'))).toBe(
        true,
      );
    }
    // Skills are not part of preflight — UI shows a static reminder.
    expect(result.blocking.every((m) => !m.toLowerCase().includes('skill'))).toBe(true);
  });

  it('blocking[] empty when Claude bin present + MCP installed', () => {
    // Wire up an MCP entry under the temp HOME so the Claude MCP check
    // returns installed.
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { morion: { command: '/x', args: ['mcp'] } },
      }),
    );
    const result = runPreflight();
    if (!result.claude.ready) {
      // Some CI hosts won't have a working `claude` — skip the
      // happy-path assertion in that case.
      return;
    }
    expect(result.blocking).toEqual([]);
  });
});
