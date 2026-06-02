import type { CliAgentAdapter } from '../../src/core/auto-code/harness/adapter.js';
import { MockAdapter, REPO_PATH, setup, type Ctx } from './workflow-orchestrator-setup.js';

/**
 * Shared kanban-aware setup for the WorkflowOrchestrator kanban
 * scenario suites (split 2026-05-16, Morion ticket
 * 01KRJZ1DKDRKVAV2YDDZVG3152 second pass).
 *
 *  - `setupWithKanban()` wraps the base `setup()` and flips the folder
 *    settings to `enabled=true / autoCodeEnabled=true / linkedRepoPath`
 *    so the orchestrator's gates admit the run end-to-end.
 *  - `buildHappyFactory(extraSummary?)` returns an adapter factory
 *    that produces APPROVE-verdict reviews + a configurable
 *    cli_agent summary so happy-path tests can assert on the
 *    summary-as-comment threading without rebuilding the closure
 *    in every case.
 */

export function setupWithKanban(): Ctx {
  const ctx = setup();
  ctx.folderSettings.update(ctx.folderId, {
    enabled: true,
    autoCodeEnabled: true,
    linkedRepoPath: REPO_PATH,
  });
  return ctx;
}

export function buildHappyFactory(
  extraSummary?: string,
): (agent: 'claude' | 'codex' | 'pi' | 'opencode') => CliAgentAdapter {
  return (agent) =>
    new MockAdapter(agent, {
      terminal: {
        kind: 'result',
        exitCode: 0,
        summary:
          agent === 'claude'
            ? extraSummary ?? 'fix complete'
            : '{"verdict":"approve","reason":"ok"}',
        costUsd: agent === 'claude' ? 0.4 : 0.05,
        terminalReason: 'completed',
        timestamp: Date.now(),
      },
    });
}
