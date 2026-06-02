import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeCwdForClaudeProjects,
  transcriptDir,
  transcriptPath,
  parseTranscriptText,
  parseTranscriptFile,
  watchTranscript,
} from '../src/core/auto-code/transcript-reader.js';

/**
 * Auto-code Phase 3 — transcript reader tests
 * (sub-ticket 01KQEEDPHX13B92BXKH8G3M9EG, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 */

describe('encodeCwdForClaudeProjects', () => {
  it('encodes slashes as hyphens', () => {
    expect(encodeCwdForClaudeProjects('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('encodes dots as hyphens (so /.claude/ → --claude-)', () => {
    expect(encodeCwdForClaudeProjects('/repo/.claude/worktrees/auto-x')).toBe(
      '-repo--claude-worktrees-auto-x',
    );
  });

  it('encodes underscores as hyphens', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/Projects/me_mcp')).toBe(
      '-Users-me-Projects-me-mcp',
    );
  });

  it('preserves uppercase, digits, existing hyphens', () => {
    expect(encodeCwdForClaudeProjects('/Users/Foo-Bar/proj-123')).toBe(
      '-Users-Foo-Bar-proj-123',
    );
  });

  it('does NOT collapse runs of hyphens — disambiguates path boundaries', () => {
    // The double-hyphen at /. is the encoder's only signal that
    // there was a directory boundary right before a hidden file.
    // Collapsing them would make /repo.claude/foo and /repo/.claude/foo
    // collide — they must stay distinct.
    expect(encodeCwdForClaudeProjects('/repo/./bar')).toBe('-repo---bar');
    expect(encodeCwdForClaudeProjects('/repo/.x/bar')).toBe('-repo--x-bar');
    expect(encodeCwdForClaudeProjects('/repo.x/bar')).toBe('-repo-x-bar');
  });

  it('matches the verbatim-observed Tetris worktree shape', () => {
    expect(
      encodeCwdForClaudeProjects(
        '/private/tmp/morion-spike-tetris-1777526713/.claude/worktrees/auto-01kqey5fzmrs88298pbht5n33f',
      ),
    ).toBe(
      '-private-tmp-morion-spike-tetris-1777526713--claude-worktrees-auto-01kqey5fzmrs88298pbht5n33f',
    );
  });
});

describe('transcriptDir / transcriptPath', () => {
  let homeDir: string;
  let prevHome: string | undefined;
  let repoDir: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'morion-transcript-home-'));
    process.env.HOME = homeDir;
    repoDir = mkdtempSync(join(tmpdir(), 'morion-transcript-repo-'));
    mkdirSync(join(repoDir, '.claude', 'worktrees', 'auto-x'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the encoded ~/.claude/projects dir for the worktree cwd', () => {
    const dir = transcriptDir(repoDir, 'auto-x');
    expect(dir).not.toBeNull();
    expect(dir!.startsWith(join(homeDir, '.claude', 'projects'))).toBe(true);
    // Encoded suffix matches the worktree's canonical path with /
    // and . replaced by -.
    expect(dir!.endsWith('-claude-worktrees-auto-x')).toBe(true);
  });

  it('returns null when neither the worktree dir nor the repo dir exists', () => {
    const path = transcriptPath('/tmp/morion-not-a-real-path-xyz', 'auto-x', 'sess1');
    expect(path).toBeNull();
  });

  it('transcriptPath = transcriptDir + sessionId.jsonl', () => {
    const dir = transcriptDir(repoDir, 'auto-x');
    const path = transcriptPath(repoDir, 'auto-x', 'session-uuid-123');
    expect(path).toBe(join(dir!, 'session-uuid-123.jsonl'));
  });
});

describe('parseTranscriptText — all observed JSONL row types', () => {
  it('skips queue-operation, ai-title, attachment, last-prompt rows', () => {
    const raw = [
      '{"type":"queue-operation","operation":"enqueue"}',
      '{"type":"ai-title","title":"hello"}',
      '{"type":"attachment","name":"foo.png"}',
      '{"type":"last-prompt"}',
    ].join('\n');
    const r = parseTranscriptText(raw);
    expect(r.messages).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('parses a string-content user message', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-04-30T10:16:17Z',
      message: { role: 'user', content: 'do the thing' },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      id: 'u1',
      kind: 'user',
      text: 'do the thing',
      timestamp: '2026-04-30T10:16:17Z',
    });
  });

  it('parses an assistant message with text + tool_use blocks as separate UI rows', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-04-30T10:16:30Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll read the file." },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/repo/src/foo.ts' },
          },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toMatchObject({
      kind: 'assistant',
      text: "I'll read the file.",
    });
    expect(r.messages[1]).toMatchObject({
      kind: 'tool_use',
      text: 'Read(/repo/src/foo.ts)',
      toolUse: { name: 'Read', id: 'toolu_1' },
    });
  });

  it('parses a tool_result block from a user message (Anthropic API shape)', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'file contents here' }],
          },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      kind: 'tool_result',
      text: 'file contents here',
      toolResult: { toolUseId: 'toolu_1', isError: false },
    });
  });

  it('flags is_error=true on failed tool results so the UI can paint them red', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u3',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: 'Permission denied',
          },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages[0]?.toolResult?.isError).toBe(true);
  });

  it('truncates long tool input previews so the row stays one line', () => {
    const long = 'a'.repeat(200);
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_3',
            name: 'Bash',
            input: { command: long },
          },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages[0]?.text.length).toBeLessThan(100);
    expect(r.messages[0]?.text).toContain('Bash(');
    expect(r.messages[0]?.text).toContain('…');
  });

  it('drops empty-text blocks so a single-tool turn does not render a blank bubble', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '   \n  ' },
          { type: 'tool_use', id: 'toolu_4', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.kind).toBe('tool_use');
  });

  it('tolerates malformed JSON rows — surfaces the line as a warning, keeps reading', () => {
    const raw = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }),
      '{ this is not valid json',
      JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'third' } }),
    ].join('\n');
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]?.text).toBe('first');
    expect(r.messages[1]?.text).toBe('third');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('line 2');
  });

  it('synthesises stable ids when uuid is missing — no React-key collisions', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' } }),
    ].join('\n');
    const r = parseTranscriptText(raw);
    expect(r.messages.map((m) => m.id)).toEqual(['line-1', 'line-2']);
  });

  it('drops unknown content block types instead of crashing (forward-compat with new Anthropic blocks)', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'a-future',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'private chain-of-thought' },
          { type: 'text', text: 'visible reply' },
          { type: 'server_tool_use', name: 'web_search' },
        ],
      },
    });
    const r = parseTranscriptText(raw);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.text).toBe('visible reply');
  });
});

describe('parseTranscriptFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morion-transcript-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty result + warning when file is missing', async () => {
    const r = await parseTranscriptFile(join(dir, 'missing.jsonl'));
    expect(r.messages).toEqual([]);
    expect(r.warnings[0]).toContain('does not exist');
  });

  it('round-trips an on-disk transcript', async () => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    );
    const r = await parseTranscriptFile(path);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.text).toBe('hi');
  });
});

describe('watchTranscript', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morion-transcript-watch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange immediately with the initial parse', async () => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    const updates: number[] = [];
    const handle = watchTranscript(path, (r) => updates.push(r.messages.length), {
      debounceMs: 50,
    });
    // Wait for the initial async fire to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.stop();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]).toBe(1);
  });

  it('debounces a burst of writes into a single onChange', async () => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } }) + '\n',
    );
    const updates: number[] = [];
    const handle = watchTranscript(path, (r) => updates.push(r.messages.length), {
      debounceMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Fire a burst of appends — should coalesce into ONE onChange
    // after the 100ms debounce window.
    for (let i = 2; i <= 5; i++) {
      appendFileSync(
        path,
        JSON.stringify({
          type: 'user',
          uuid: `u${i}`,
          message: { role: 'user', content: `msg ${i}` },
        }) + '\n',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    handle.stop();
    // Initial fire (1 msg) + at most ONE coalesced update (5 msgs).
    // fs.watch granularity may produce a brief intermediate, so
    // assert the END state hit 5 rather than the exact call count.
    expect(updates[updates.length - 1]).toBe(5);
    expect(updates.length).toBeLessThanOrEqual(3);
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const path = join(dir, 'sess.jsonl');
    writeFileSync(path, '');
    const handle = watchTranscript(path, () => {}, { debounceMs: 10 });
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  it('falls back to polling when the file does not exist yet, picks up once it lands', async () => {
    const path = join(dir, 'late-sess.jsonl');
    const updates: number[] = [];
    const handle = watchTranscript(path, (r) => updates.push(r.messages.length), {
      debounceMs: 50,
    });
    // Wait then create the file. Watcher poll interval is 1s so
    // we need to wait at least that.
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(
      path,
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    handle.stop();
    // Should have at least one fire after the file appeared.
    const sawFile = updates.some((n) => n === 1);
    expect(sawFile).toBe(true);
  });
});
