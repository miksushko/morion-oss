#!/usr/bin/env node
/**
 * Test stub for the `pi` CLI (pi-coding-agent, package `pi`).
 * Emits LF-delimited JSONL matching pi's `--mode json` schema so the
 * `PiAdapter` parser can be exercised without a real installation.
 *
 * Real schema reference: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
 *
 * Env vars (per-run behavior):
 *   STUB_SESSION_ID      override pi session.id (default: derived from --session arg)
 *   STUB_SUMMARY         text emitted as final assistant message + summary in agent_end
 *                        (default: "stub run complete")
 *   STUB_TOOL_CALLS      JSON array of tool calls to emit between message events.
 *                        Shape: [{toolCallId, toolName, args, result, isError?}]
 *                        Each entry produces tool_execution_start + tool_execution_end.
 *   STUB_MESSAGE_CONTENT_FORMAT  "string" (default) | "blocks" — pick the
 *                        message.content shape so adapter handles both.
 *   STUB_NO_AGENT_END    "1" → exit cleanly without emitting agent_end (forces
 *                        adapter to surface parse_failed)
 *   STUB_HANG_AFTER_END  "1" → emit agent_end then sleep forever (until
 *                        external kill). Regression for the streaming-
 *                        terminal bug: adapter must still kill the child
 *                        on cancel even though the terminal event was
 *                        already emitted to consumers.
 *   STUB_INTERLEAVE_GARBAGE  "1" → emit a non-JSON warning line mid-stream;
 *                        adapter should skip it silently
 *   STUB_DELAY_MS        sleep before emitting (lets tests SIGTERM mid-run)
 *   STUB_EXIT_CODE       non-zero → simulate crash (no agent_end either)
 *   STUB_STDERR          text written to stderr before exit
 *   STUB_IGNORE_SIGTERM  "1" → ignore SIGTERM (regression for SIGKILL escalation)
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

const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10) || 0;

function findArgValue(name) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function buildMessageContent(text) {
  if (process.env.STUB_MESSAGE_CONTENT_FORMAT === 'blocks') {
    return [{ type: 'text', text }];
  }
  return text;
}

function emitAndExit() {
  const sessionId =
    process.env.STUB_SESSION_ID ||
    findArgValue('--session') ||
    'pi-stub-' + Date.now().toString(36);
  const summary = process.env.STUB_SUMMARY || 'stub run complete';

  // 1. session header (always first)
  emit({
    type: 'session',
    version: 1,
    id: sessionId,
    timestamp: Date.now(),
    cwd: process.cwd(),
  });

  // 2. agent_start (lifecycle bookkeeping — adapter should ignore)
  emit({ type: 'agent_start' });

  // 3. turn_start
  emit({ type: 'turn_start' });

  // 4. message_start (lifecycle — adapter should ignore)
  emit({
    type: 'message_start',
    message: { role: 'assistant', content: '' },
  });

  // Optional tool execution events.
  if (process.env.STUB_TOOL_CALLS) {
    let toolCalls;
    try {
      toolCalls = JSON.parse(process.env.STUB_TOOL_CALLS);
    } catch {
      toolCalls = [];
    }
    for (const tc of toolCalls) {
      emit({
        type: 'tool_execution_start',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: tc.result,
        isError: !!tc.isError,
      });
    }
  }

  // Optional garbage line — adapter should silently skip it.
  if (process.env.STUB_INTERLEAVE_GARBAGE === '1') {
    process.stdout.write('warning: this is not JSON\n');
  }

  // 5. message_end with the final assistant content
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: buildMessageContent(summary),
    },
  });

  // 6. turn_end
  emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: buildMessageContent(summary),
    },
    toolResults: [],
  });

  // 7. agent_end (terminal — unless STUB_NO_AGENT_END forces skip)
  if (process.env.STUB_NO_AGENT_END !== '1') {
    emit({
      type: 'agent_end',
      messages: [
        {
          role: 'user',
          content: 'stub prompt',
        },
        {
          role: 'assistant',
          content: buildMessageContent(summary),
        },
      ],
    });
  }

  if (process.env.STUB_HANG_AFTER_END === '1') {
    // Sleep forever after emitting agent_end. The harness adapter
    // already saw the terminal event and closed the broadcast, but
    // the child must still be killable via cancel(). Without the
    // _terminalEventEmitted/_processReaped split (Codex T5 P1), the
    // adapter would early-return on cancel and leave this zombie.
    setInterval(() => {
      /* keep event loop alive */
    }, 60_000);
    return;
  }

  process.exit(0);
}

if (delayMs > 0) {
  setTimeout(emitAndExit, delayMs);
} else {
  emitAndExit();
}
