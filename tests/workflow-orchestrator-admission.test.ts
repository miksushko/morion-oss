import { describe, expect, it } from 'vitest';

import { WorkflowOrchestrator } from '../src/core/auto-code/workflows/workflow-orchestrator.js';
import { parseLinearWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';

import {
  REPO_PATH,
  STUB_PREFLIGHT_OK,
  TICKET_TITLE,
  TICKET_BODY,
  TRANSCRIPT_DIR,
  buildOrchestrator,
  makeResult,
  makeRunner,
  setup,
  MockAdapter,
  type Ctx,
} from './helpers/workflow-orchestrator-setup.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';

/**
 * WorkflowOrchestrator — T7.B.2.x atomic-admission regressions
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator.test.ts
 * (Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 */

describe('WorkflowOrchestrator — Codex T7.B.2.x atomic-admission regressions', () => {
  function setupForAdmission() {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    return ctx;
  }

  it('concurrent duplicate enqueue: ensureWorktree fires only once', async () => {
    const ctx = setupForAdmission();
    let ensureWorktreeCalls = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: makeResult({
          summary:
            agent === 'codex' ? '{"verdict":"approve","reason":"ok"}' : 'fix',
          costUsd: 0.05,
        }),
      });
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {
        ensureWorktreeCalls += 1;
        // Hold a beat so a parallel enqueue is guaranteed to start
        // BEFORE this one finishes its admission flow.
        await new Promise((r) => setTimeout(r, 30));
      },
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    // Fire two enqueues simultaneously. The schema's partial unique
    // index collapses both onto the same workflow_runs row; the
    // loser's enqueueTicket short-circuits BEFORE ensureWorktree.
    const [a, b] = await Promise.all([
      orch.enqueueTicket(ctx.ticketId, ctx.folderId),
      orch.enqueueTicket(ctx.ticketId, ctx.folderId),
    ]);
    if (a.kind !== 'enqueued' || b.kind !== 'enqueued') {
      throw new Error('expected both enqueued');
    }
    expect(a.runId).toBe(b.runId);
    // Exactly one of them is the deduped path.
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1);
    expect(ensureWorktreeCalls).toBe(1);
    await Promise.all([a.handle.awaitTerminal(), b.handle.awaitTerminal()]);
  });

  it('status changes during ensureWorktree → run cancelled, worktree cleaned, kanban untouched', async () => {
    const ctx = setupForAdmission();
    let claudeSpawned = 0;
    let cleanupCalls = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      claudeSpawned += 1;
      return new MockAdapter(agent, { terminal: makeResult() });
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      // Inside ensureWorktree, simulate the user dragging the card
      // OUT of `todo` (e.g. to backlog) — that's the race the
      // post-worktree stale check guards against.
      ensureWorktree: async () => {
        ctx.notes.moveToKanban(ctx.ticketId, 'backlog', null, 'user');
      },
      cleanupWorktree: async () => {
        cleanupCalls += 1;
      },
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('ticket_no_longer_todo');
    }
    // Runner never spawned — card was already gone.
    expect(claudeSpawned).toBe(0);
    // Cleanup ran (best-effort).
    expect(cleanupCalls).toBe(1);
    // Card stays where the user put it.
    expect(ctx.notes.getById(ctx.ticketId)?.status).toBe('backlog');
    // The claimed run row is marked cancelled (not failed) so it
    // doesn't poison the per-folder cap or look like a real failure.
    const runs = ctx.runsRepo.listRunsForTicket(ctx.ticketId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('cancelled');
    expect(runs[0].lastError).toMatch(/ticket_no_longer_todo/);
  });

  it('dedupe path does not start a second dispatcher (P1.1)', async () => {
    // Pin the P1.1 finding: the deduped enqueue branch must NOT
    // start a second dispatch loop. Externally observable proof:
    // for a 2-stage run, there are exactly 2 stage rows (one per
    // graph stage), not 4 (two per stage from racing dispatchers).
    const ctx = setupForAdmission();
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: makeResult({
          summary:
            agent === 'codex' ? '{"verdict":"approve","reason":"ok"}' : 'fix',
          costUsd: 0.05,
        }),
      });
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    let resolveSlow: () => void = () => {};
    const slow = new Promise<void>((r) => {
      resolveSlow = r;
    });
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {
        // Slow setup so a parallel enqueue overlaps inside admission.
        await slow;
      },
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const firstP = orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    await new Promise((r) => setTimeout(r, 20));
    const secondP = orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    resolveSlow();
    const [first, second] = await Promise.all([firstP, secondP]);
    if (first.kind !== 'enqueued' || second.kind !== 'enqueued') {
      throw new Error('expected both enqueued');
    }
    expect(first.runId).toBe(second.runId);
    expect([first.deduped, second.deduped].filter(Boolean)).toHaveLength(1);
    const final = await first.handle.awaitTerminal();
    expect(final.status).toBe('done');
    // Exactly 2 stage rows (fix + review), not 4 — proving only one
    // dispatcher ran. A second dispatchExisting call on a non-
    // pending row would have spawned its own loop and produced a
    // duplicate fix attempt.
    const stages = ctx.runsRepo.listStagesForRun(final.id);
    expect(stages).toHaveLength(2);
    expect(stages.map((s) => s.stageIdInGraph).sort()).toEqual(['fix', 'review']);
  });

  it('cancelRequested set during ensureWorktree → run cancelled, dispatch skipped (P1.3)', async () => {
    const ctx = setupForAdmission();
    let claudeSpawned = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      claudeSpawned += 1;
      return new MockAdapter(agent, { terminal: makeResult() });
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    let setCancelDuringEnsure: (() => void) | null = null;
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {
        // Simulate toggle-off / cancelTicket arriving DURING the
        // worktree setup. Flip cancel_requested on the claimed row;
        // the post-ensureWorktree gate must catch it.
        setCancelDuringEnsure?.();
      },
      cleanupWorktree: async () => {},
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    setCancelDuringEnsure = () => {
      const active = ctx.runsRepo.findActiveRunForTicket(ctx.folderId, ctx.ticketId);
      if (active) {
        ctx.runsRepo.updateRun(active.id, { cancelRequested: true });
      }
    };
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('cancelled_during_admission');
    }
    expect(claudeSpawned).toBe(0);
    // Card stays in `todo` — the user didn't drag it; they just
    // toggled the engine off.
    expect(ctx.notes.getById(ctx.ticketId)?.status).toBe('todo');
    const runs = ctx.runsRepo.listRunsForTicket(ctx.ticketId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('cancelled');
    expect(runs[0].lastError).toMatch(/cancelled_during_admission/);
  });

  it('runner.dispatch refuses to fire onRunStart when cancelRequested already set (P1.4)', async () => {
    // Simulate: a row is claimed pending, then cancelRequested
    // flipped (e.g. by the orchestrator's post-ensureWorktree
    // check OR by an external cancel arriving via toggle-off
    // before dispatch entered the loop). The runner MUST NOT
    // promote the row to `running` or fire onRunStart (which
    // would move the kanban to `doing` against user intent).
    const ctx = setupForAdmission();
    let onRunStartFired = false;
    let claudeSpawned = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      claudeSpawned += 1;
      return new MockAdapter(agent, { terminal: makeResult() });
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    // Seed a pending run + flip cancel_requested before dispatch.
    const { run } = ctx.runsRepo.createRun({
      folderId: ctx.folderId,
      ticketId: ctx.ticketId,
      graphSnapshot: parseLinearWorkflow(LEGACY_LINEAR_AUTOCODE_DEFINITION),
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/x`,
      initialStatus: 'pending',
    });
    ctx.runsRepo.updateRun(run.id, { cancelRequested: true });
    const handle = runner.dispatchExisting({
      runId: run.id,
      ticketContext: { id: ctx.ticketId, title: 'X', body: 'x' },
      hooks: {
        onRunStart: () => {
          onRunStartFired = true;
        },
      },
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('cancelled');
    expect(onRunStartFired).toBe(false);
    expect(claudeSpawned).toBe(0);
  });

  it('claudeBinPath is no longer required to construct the orchestrator', () => {
    // T7.B.2.x dropped the actionability gate; claudeBinPath was its
    // only consumer. The deps interface no longer accepts the field;
    // this test pins that the orchestrator constructs cleanly without it.
    const ctx = setup();
    expect(() =>
      new WorkflowOrchestrator({
        db: ctx.db,
        notes: ctx.notes,
        folders: ctx.folders,
        comments: ctx.comments,
        audit: ctx.audit,
        folderSettings: ctx.folderSettings,
        runsRepo: ctx.runsRepo,
        runner: makeRunner(ctx),
      }),
    ).not.toThrow();
  });
});
