#!/usr/bin/env node
/**
 * Test stub for the `opencode` CLI ([opencode-ai/opencode](https://github.com/opencode-ai/opencode)).
 * Emits LF-delimited JSONL matching a plausible `--format json` event
 * shape so the `OpencodeAdapter` parser can be exercised without a
 * real installation.
 *
 * Real schema is undocumented at the discriminator-value level
 * (https://opencode.ai/docs/sdk/ — only mentions `event.type`); this
 * stub uses one of the variant names the mapper accepts so we
 * exercise the streaming path. Real-CLI smoke (L1.T10) will pin the
 * actual names.
 *
 * Env vars:
 *   STUB_SESSION_ID      override session id (default: derived from --session arg)
 *   STUB_SUMMARY         text in final result (default: "stub run complete")
 *   STUB_COST            cost reported in result event (default: 0)
 *   STUB_TOOL_CALLS      JSON array: [{id, name, input, output}]
 *                        Each entry → tool.start + tool.end events.
 *   STUB_NO_TERMINAL     "1" → exit cleanly without emitting result event
 *                        (forces adapter's stdout-fallback path)
 *   STUB_EMIT_ERROR      "1" → emit `{type:'error',message:...}` event
 *                        and exit 0 (terminal error via stream)
 *   STUB_SINGLE_ENVELOPE "1" → emit ONE JSON object only, no
 *                        streaming (claude-style) — exercises adapter's
 *                        single-envelope fallback in _handleNormalClose
 *   STUB_MESSAGE_FORMAT  "string" (default) | "blocks" — message content shape
 *   STUB_TYPE_VARIANT    chooses event names for variety:
 *                          "snake" (default) → session_start, tool_use_start, message_end, agent_end
 *                          "dot"             → session.created, tool.start, message.complete, complete
 *   STUB_DELAY_MS        pre-emit sleep (lets tests SIGTERM mid-run)
 *   STUB_EXIT_CODE       non-zero → simulate crash
 *   STUB_STDERR          text written to stderr before exit
 *   STUB_IGNORE_SIGTERM  "1" → ignore SIGTERM (SIGKILL escalation regression)
 *   STUB_LOG_ARGS_TO     file path for argv dump
 */

const fs = require('node:fs');

const args = process.argv.slice(2);

if (process.env.STUB_LOG_ARGS_TO) {
  fs.writeFileSync(
    process.env.STUB_LOG_ARGS_TO,
    JSON.stringify({ args, cwd: process.cwd() }, null, 2),
  );
}

if (process.env.STUB_STDERR) {
  process.stderr.write(process.env.STUB_STDERR);
}

if (process.env.STUB_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    /* noop */
  });
}

if (process.env.STUB_EXIT_CODE && process.env.STUB_EXIT_CODE !== '0') {
  process.exit(parseInt(process.env.STUB_EXIT_CODE, 10));
}

// Real opencode `--format json` schema (verified against takopi
// cheatsheet, 2026-05-09). Codex T10 review P1: pre-fix stub used
// fictional names; this stub matches the actual schema:
//   - step_start (sessionID, part: {id, type:'step-start', snapshot})
//   - tool_use (state.{status,input,output,time})
//   - text (part.text)
//   - step_finish (part.{reason,cost,tokens})
//   - error (error.{name,data.message})
const NAMES = {
  stepStart: 'step_start',
  toolUse: 'tool_use',
  text: 'text',
  stepFinish: 'step_finish',
  error: 'error',
};

function findArgValue(name) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function buildContent(text) {
  if (process.env.STUB_MESSAGE_FORMAT === 'blocks') {
    return [{ type: 'text', text }];
  }
  return text;
}

const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10) || 0;

function emitAndExit() {
  const sessionId =
    process.env.STUB_SESSION_ID ||
    findArgValue('--session') ||
    'opencode-stub-' + Date.now().toString(36);
  const summary = process.env.STUB_SUMMARY || 'stub run complete';
  const cost = parseFloat(process.env.STUB_COST || '0');

  if (process.env.STUB_SINGLE_ENVELOPE === '1') {
    // Single-envelope mode: one JSON object on stdout, no streaming.
    // Adapter falls back to parsing whole stdout as one document.
    // Use the real terminal event shape so the adapter recognises it.
    process.stdout.write(
      JSON.stringify({
        type: NAMES.stepFinish,
        timestamp: Date.now(),
        sessionID: sessionId,
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    );
    process.exit(0);
  }

  // 1. step_start — first event, carries authoritative sessionID
  emit({
    type: NAMES.stepStart,
    timestamp: Date.now(),
    sessionID: sessionId,
    part: {
      id: 'prt_' + Math.random().toString(36).slice(2, 12),
      sessionID: sessionId,
      messageID: 'msg_' + Math.random().toString(36).slice(2, 12),
      type: 'step-start',
      snapshot: 'sha-' + Math.random().toString(36).slice(2, 12),
    },
  });

  // Optional tool events — opencode emits ONE tool_use per tool with
  // status='completed' carrying input/output/time.
  if (process.env.STUB_TOOL_CALLS) {
    let toolCalls;
    try {
      toolCalls = JSON.parse(process.env.STUB_TOOL_CALLS);
    } catch {
      toolCalls = [];
    }
    for (const tc of toolCalls) {
      const startTs = Date.now();
      const endTs = startTs + 50;
      emit({
        type: NAMES.toolUse,
        timestamp: Date.now(),
        sessionID: sessionId,
        part: {
          tool: tc.name,
          state: {
            status: 'completed',
            input: tc.input,
            output: tc.output,
            metadata: { exit: 0 },
            time: { start: startTs, end: endTs },
          },
        },
      });
    }
  }

  // 2. text event with model output. opencode wraps in part.text.
  emit({
    type: NAMES.text,
    timestamp: Date.now(),
    sessionID: sessionId,
    part: {
      type: 'text',
      text: summary,
      time: { start: Date.now(), end: Date.now() },
    },
  });

  // Optional error event (terminal via stream)
  if (process.env.STUB_EMIT_ERROR === '1') {
    emit({
      type: NAMES.error,
      timestamp: Date.now(),
      sessionID: sessionId,
      error: {
        name: 'StubError',
        data: { message: 'opencode failed mid-run' },
      },
    });
    process.exit(0);
  }

  // 3. step_finish (terminal when reason='stop' — unless STUB_NO_TERMINAL)
  if (process.env.STUB_NO_TERMINAL !== '1') {
    emit({
      type: NAMES.stepFinish,
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        type: 'step-finish',
        reason: 'stop',
        cost,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
  }

  process.exit(0);
}

if (delayMs > 0) {
  setTimeout(emitAndExit, delayMs);
} else {
  emitAndExit();
}
