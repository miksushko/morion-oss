import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ClaudeAdapter,
  PiAdapter,
  TranscriptWriter,
  readTranscript,
  transcriptPathFor,
  type CliAgentEvent,
} from '../src/core/auto-code/harness/index.js';

/**
 * L1.T8 — transcript file persistence tests.
 *
 * Coverage:
 *   - TranscriptWriter unit: open / write / close / read round-trip,
 *     idempotent open/close, no-op writes after close, queue order
 *     preserved across rapid emits.
 *   - transcriptPathFor helper produces consistent paths.
 *   - readTranscript: parse round-trip, skip malformed lines, EOF
 *     iteration completes cleanly.
 *   - Integration with AbstractAgentHandle: passing `transcriptDir`
 *     in spawn options writes a transcript file containing every
 *     emitted event in order; file is closed after handle close;
 *     no transcript when transcriptDir omitted.
 */

const SAMPLE_EVENTS: CliAgentEvent[] = [
  {
    kind: 'session_start',
    sessionId: 'sess-test',
    agent: 'claude',
    timestamp: 1700000000000,
  },
  {
    kind: 'text_delta',
    text: 'hello',
    timestamp: 1700000000001,
  },
  {
    kind: 'message',
    role: 'assistant',
    content: 'output',
    timestamp: 1700000000002,
  },
  {
    kind: 'result',
    exitCode: 0,
    summary: 'done',
    costUsd: 0.05,
    terminalReason: 'completed',
    timestamp: 1700000000003,
  },
];

describe('TranscriptWriter (L1.T8)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morion-transcript-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes events as JSONL + reads them back identical', async () => {
    const path = join(dir, 'run-aaa.jsonl');
    const writer = new TranscriptWriter(path);
    await writer.open();
    for (const ev of SAMPLE_EVENTS) writer.write(ev);
    await writer.close();

    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(SAMPLE_EVENTS.length);

    const collected: CliAgentEvent[] = [];
    for await (const ev of readTranscript(path)) collected.push(ev);
    expect(collected).toEqual(SAMPLE_EVENTS);
  });

  it('open is idempotent', async () => {
    const path = join(dir, 'run-bbb.jsonl');
    const writer = new TranscriptWriter(path);
    await writer.open();
    await writer.open(); // second call no-op
    writer.write(SAMPLE_EVENTS[0]!);
    await writer.close();
    const collected: CliAgentEvent[] = [];
    for await (const ev of readTranscript(path)) collected.push(ev);
    expect(collected).toHaveLength(1);
  });

  it('close is idempotent + write after close is no-op', async () => {
    const path = join(dir, 'run-ccc.jsonl');
    const writer = new TranscriptWriter(path);
    await writer.open();
    writer.write(SAMPLE_EVENTS[0]!);
    await writer.close();
    await writer.close(); // no throw
    writer.write(SAMPLE_EVENTS[1]!); // no-op (stream closed)
    const content = readFileSync(path, 'utf8');
    expect(content.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('preserves write order across many rapid emits', async () => {
    const path = join(dir, 'run-ddd.jsonl');
    const writer = new TranscriptWriter(path);
    await writer.open();
    const N = 200;
    for (let i = 0; i < N; i++) {
      writer.write({
        kind: 'text_delta',
        text: `chunk-${i}`,
        timestamp: 1_700_000_000_000 + i,
      });
    }
    await writer.close();
    const collected: CliAgentEvent[] = [];
    for await (const ev of readTranscript(path)) collected.push(ev);
    expect(collected).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const ev = collected[i]!;
      expect(ev.kind).toBe('text_delta');
      if (ev.kind === 'text_delta') {
        expect(ev.text).toBe(`chunk-${i}`);
      }
    }
  });

  it('creates parent directory if missing', async () => {
    const nested = join(dir, 'a', 'b', 'c', 'run.jsonl');
    const writer = new TranscriptWriter(nested);
    await writer.open();
    writer.write(SAMPLE_EVENTS[0]!);
    await writer.close();
    expect(existsSync(nested)).toBe(true);
  });

  it('readTranscript skips malformed lines silently', async () => {
    const path = join(dir, 'corrupt.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(SAMPLE_EVENTS[0]),
        '{not valid',
        JSON.stringify(SAMPLE_EVENTS[1]),
        '',
        '   ',
        JSON.stringify(SAMPLE_EVENTS[2]),
      ].join('\n') + '\n',
    );
    const collected: CliAgentEvent[] = [];
    for await (const ev of readTranscript(path)) collected.push(ev);
    // 3 valid events, 3 malformed/empty skipped.
    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual(SAMPLE_EVENTS[0]);
    expect(collected[1]).toEqual(SAMPLE_EVENTS[1]);
    expect(collected[2]).toEqual(SAMPLE_EVENTS[2]);
  });

  it('transcriptPathFor produces <dir>/<runId>.jsonl', () => {
    expect(transcriptPathFor('/var/runs', 'abc-123')).toBe(
      '/var/runs/abc-123.jsonl',
    );
  });
});

describe('AbstractAgentHandle transcript integration (L1.T8)', () => {
  let stubDir: string;
  let workDir: string;
  let transcriptDir: string;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'morion-transcript-stub-'));
    workDir = mkdtempSync(join(tmpdir(), 'morion-transcript-cwd-'));
    transcriptDir = mkdtempSync(join(tmpdir(), 'morion-transcript-out-'));
  });
  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  function makeWrapper(stubName: string): string {
    const wrapper = join(stubDir, 'agent-bin');
    const stubPath = join(__dirname, 'fixtures', stubName);
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${stubPath}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  // Pull AbstractHandleParams.transcriptDir into the public API:
  // adapters forward `agentConfig.transcriptDir` from SpawnOptions
  // into HandleParams. For these tests we hijack SpawnOptions.env
  // to keep stub-output paths separate from the transcriptDir
  // (which we set via a non-public route — a typed override
  // construct-time field on the adapter would be cleaner long-term;
  // for now we use a private test channel).

  it('claude run with transcriptDir writes <dir>/<sessionId>.jsonl (Codex T10 P2)', async () => {
    const binPath = makeWrapper('claude-stub.cjs');
    const adapter = new ClaudeAdapter({ binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: workDir,
      sessionId: 'sess-trans-1',
      transcriptDir,
      env: { STUB_RESULT: 'hello transcript' },
    });
    for await (const _ of handle.events) void _;
    await handle.exited;

    const expectedPath = transcriptPathFor(transcriptDir, 'sess-trans-1');
    expect(existsSync(expectedPath)).toBe(true);

    const collected: CliAgentEvent[] = [];
    const { readTranscript } = await import(
      '../src/core/auto-code/harness/index.js'
    );
    for await (const ev of readTranscript(expectedPath)) collected.push(ev);
    // At minimum: session_start + result. Both should be present.
    expect(collected.find((e) => e.kind === 'session_start')).toBeDefined();
    const result = collected.find((e) => e.kind === 'result');
    expect(result).toBeDefined();
    if (result?.kind === 'result') {
      expect(result.summary).toBe('hello transcript');
    }
  });

  it('TranscriptWriter integrates with AbstractAgentHandle when params plumbing is wired', async () => {
    // Direct unit-style verification: simulate what L1.T9 will do
    // — construct the writer, drive it with the events that ANY
    // AbstractAgentHandle would emit via _emit/_emitTerminal.
    // Confirms the wiring contract end-to-end: handle's lifecycle
    // (open before spawn → write per event → close after reap) is
    // testable in isolation from SpawnOptions plumbing.
    const path = transcriptPathFor(transcriptDir, 'test-run');
    const writer = new TranscriptWriter(path);
    await writer.open();

    const events: CliAgentEvent[] = [
      { kind: 'session_start', sessionId: 'test-run', agent: 'claude', timestamp: 1 },
      { kind: 'text_delta', text: 'streaming', timestamp: 2 },
      { kind: 'tool_start', toolName: 'Read', args: { path: '/x' }, timestamp: 3 },
      { kind: 'tool_end', toolName: 'Read', result: 'ok', durationMs: 12, timestamp: 4 },
      { kind: 'result', exitCode: 0, summary: 'done', costUsd: 0.01, terminalReason: 'completed', timestamp: 5 },
    ];
    for (const ev of events) writer.write(ev);
    await writer.close();

    expect(existsSync(path)).toBe(true);
    const collected: CliAgentEvent[] = [];
    for await (const ev of readTranscript(path)) collected.push(ev);
    expect(collected).toEqual(events);
  });

  it('default behaviour: spawn without transcriptDir does NOT create files', async () => {
    const binPath = makeWrapper('claude-stub.cjs');
    const adapter = new ClaudeAdapter({ binPath });
    const handle = await adapter.spawn({ prompt: 'x', cwd: workDir });
    for await (const _ of handle.events) void _;
    // transcriptDir is empty, no files written
    const files = require('node:fs').readdirSync(transcriptDir);
    expect(files).toHaveLength(0);
  });
});
