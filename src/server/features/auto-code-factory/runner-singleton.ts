import type { WorkflowRunner } from '../../../core/auto-code/workflows/runner.js';

/**
 * Process-level `WorkflowRunner` registry, keyed by the DB handle.
 *
 * `buildWorkflowOrchestrator` is a PER-REQUEST factory, but the runner is
 * the one long-lived, stateful component: it holds the in-memory registry
 * of in-flight runs and their LIVE cli_agent adapter handles (its private
 * `states` map). Those handles are what `runner.cancel(runId)` signals to
 * SIGTERM the running agent process.
 *
 * Without a singleton, every request minted a fresh runner with an empty
 * `states` map. A run STARTED from request A (kanban drag → `todo`, or the
 * scheduler tick) held its live handle in runner A. When the user later
 * dragged the card to `backlog` — or hit a Stop button — request B built
 * runner B, called `cancel(runId)`, and found NOTHING in its empty map to
 * signal. The DB `cancelRequested` flag flipped (so the run eventually
 * stopped at the next stage boundary), but the in-flight cli_agent stage
 * was never killed and ran to completion, burning budget. That is the
 * "auto-stop doesn't work / it keeps spending money" bug.
 *
 * Keying by the DB handle keeps tests isolated for free: each test opens a
 * fresh `:memory:` db (a distinct object key → a distinct runner), while
 * production runs one db per process → exactly one runner. The WeakMap
 * also lets a closed db's runner be GC'd once nothing else references it.
 */
const runnerByDb = new WeakMap<object, WorkflowRunner>();

/**
 * Return the process-shared runner for `dbKey`, constructing it via
 * `build` on first use. Subsequent calls for the same db return the same
 * instance so a cancel issued from any request reaches the live run.
 */
export function getOrCreateWorkflowRunner(
  dbKey: object,
  build: () => WorkflowRunner,
): WorkflowRunner {
  const existing = runnerByDb.get(dbKey);
  if (existing) return existing;
  const runner = build();
  runnerByDb.set(dbKey, runner);
  return runner;
}
