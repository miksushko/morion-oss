#!/usr/bin/env node
/**
 * Test stub for `claude` CLI — emits a fixture envelope matching the
 * spike-confirmed shape (`--output-format json`).
 *
 * Behaviour controlled by env vars (so tests can dictate per-run
 * outcomes without rewriting the stub):
 *
 *   STUB_TERMINAL_REASON  completed (default) | budget | error
 *   STUB_RESULT           free-text result body (default: "stub ok")
 *   STUB_COST             total_cost_usd (default: 0.05)
 *   STUB_DELAY_MS         pre-emit sleep, lets tests SIGTERM mid-run
 *   STUB_EXIT_CODE        non-zero to simulate crash WITHOUT JSON
 *   STUB_STDERR           string to write to stderr before exit
 *   STUB_LOG_ARGS_TO      file path to dump argv (test verification)
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

// SIGKILL escalation regression: when set, the stub registers a
// SIGTERM handler that does nothing, so the parent must escalate to
// SIGKILL within the grace window. Without this, the parent's SIGTERM
// kills the stub immediately (default Node behaviour).
if (process.env.STUB_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    // noop — pretend we didn't get the signal
  });
}

if (process.env.STUB_EXIT_CODE && process.env.STUB_EXIT_CODE !== '0') {
  // No JSON envelope — simulates a hard crash. The launcher should
  // surface this as terminalReason='error' with stderrTail populated.
  process.exit(parseInt(process.env.STUB_EXIT_CODE, 10));
}

const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10) || 0;

function emitAndExit() {
  // Honour the caller's --session-id so tests can verify roundtrip.
  let sessionId = 'stub-session-' + Date.now().toString(36);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--session-id') {
      sessionId = args[i + 1];
      break;
    }
  }

  const envelope = {
    type: 'result',
    subtype:
      process.env.STUB_TERMINAL_REASON === 'error' ? 'error' : 'success',
    is_error: process.env.STUB_TERMINAL_REASON === 'error',
    api_error_status: null,
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    result: process.env.STUB_RESULT || 'stub ok',
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: parseFloat(process.env.STUB_COST || '0.05'),
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    },
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: parseFloat(process.env.STUB_COST || '0.05'),
      },
    },
    permission_denials: [],
    terminal_reason: process.env.STUB_TERMINAL_REASON || 'completed',
    fast_mode_state: 'off',
    uuid: 'stub-uuid',
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exit(0);
}

if (delayMs > 0) {
  setTimeout(emitAndExit, delayMs);
} else {
  emitAndExit();
}
