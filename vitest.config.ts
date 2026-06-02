import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks', // better-sqlite3 doesn't like worker threads
    // Spawn-based harness tests (claude/codex/pi/opencode adapters,
    // ~150 tests that spawn child stubs) get OS-level contention
    // when many run in parallel — process creation, file I/O,
    // SIGTERM/SIGKILL chains all hit the kernel concurrently. The
    // default 5s timeout occasionally trips under that load even
    // though the tests are healthy. 15s gives headroom for the
    // worst-case spawn storm without masking real hangs (a real
    // hang would be 30s+ since the SIGKILL grace + cleanup chain
    // resolves within ~2s).
    testTimeout: 15_000,
  },
});
