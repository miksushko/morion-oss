#!/usr/bin/env node
/**
 * Test stub for `codex` CLI — emits a verdict line on stdout that the
 * codex-launcher's parseVerdict() can read back.
 *
 * The older OpenAI codex CLI doesn't speak JSON natively; our
 * convention is "ask the model to print one line of JSON, parse the
 * last JSON-shaped line from stdout". This stub plays that role: it
 * doesn't speak to a real model, it just prints whatever the test
 * env vars dictate.
 *
 * Env vars:
 *   STUB_VERDICT      approve | reopen | escalate (default: approve)
 *   STUB_REASON       reason text (default: "stub verdict")
 *   STUB_PREAMBLE     extra text before the JSON line (simulates
 *                     model thinking out loud)
 *   STUB_DELAY_MS     pre-emit sleep (lets tests SIGTERM mid-run)
 *   STUB_EXIT_CODE    non-zero to simulate crash
 *   STUB_STDERR       string written to stderr before exit
 *   STUB_NO_VERDICT   "1" → emit only preamble, no verdict (forces
 *                     parseVerdict's escalate fallback)
 *   STUB_INK_CRASH    "1" → emit ANSI escape sequences only, no
 *                     actual content + exit 0 (simulates codex
 *                     0.1.x Ink-UI crash in non-TTY child — silent
 *                     flavour)
 *   STUB_INK_RAWMODE  "1" → emit the full Ink "Raw mode is not
 *                     supported" sign-in menu + stack trace + exit
 *                     0 (the codex 0.1.x flavour where Ink
 *                     actually paints the menu before crashing)
 *   STUB_LOG_ARGS_TO  file path for argv dump
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

if (process.env.STUB_EXIT_CODE && process.env.STUB_EXIT_CODE !== '0') {
  process.exit(parseInt(process.env.STUB_EXIT_CODE, 10));
}

const delayMs = parseInt(process.env.STUB_DELAY_MS || '0', 10) || 0;

function emitAndExit() {
  if (process.env.STUB_INK_CRASH === '1') {
    // Real codex 0.1.x output when Ink crashes in non-TTY: terminal
    // setup escapes (clear screen, cursor home) and nothing else.
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H\x1b[?25l');
    process.exit(0);
  }
  if (process.env.STUB_INK_RAWMODE === '1') {
    // Verbatim slice of the actual codex 0.1.2505161800 output when
    // Ink prints the sign-in menu, then trips on
    // process.stdin.setRawMode in a non-TTY child. Trimmed but the
    // load-bearing strings stay so the unhealthy detector matches.
    process.stdout.write(
      '\x1b[2J\x1b[3J\x1b[HSign in with ChatGPT to generate an API key or paste one you already have.\n' +
        '\x1b[2m[use arrows to move, enter to select]\x1b[22m\n\n' +
        '\x1b[34m❯\x1b[39m \x1b[34mSign in with ChatGPT\x1b[39m\n' +
        '  Paste an API key (or set as OPENAI_API_KEY)\n' +
        ' \x1b[41m\x1b[37m ERROR\x1b[39m\x1b[49m Raw mode is not supported on the current process.stdin, which Ink uses\n' +
        '       as input stream by default.\n' +
        ' -handleSetRawMode (file:///opt/homebrew/lib/node_modules/@openai/codex/dist/cli.js:327:2020)\n',
    );
    process.exit(0);
  }
  if (process.env.STUB_PREAMBLE) {
    process.stdout.write(process.env.STUB_PREAMBLE + '\n');
  }
  if (process.env.STUB_NO_VERDICT !== '1') {
    const verdict = process.env.STUB_VERDICT || 'approve';
    const reason = process.env.STUB_REASON || 'stub verdict';
    process.stdout.write(
      JSON.stringify({ verdict, reason }) + '\n',
    );
  }
  process.exit(0);
}

if (delayMs > 0) {
  setTimeout(emitAndExit, delayMs);
} else {
  emitAndExit();
}
