import { describe, expect, it } from 'vitest';

import { WorkflowOrchestrator } from '../src/core/auto-code/workflows/workflow-orchestrator.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import type { CliAgentAdapter } from '../src/core/auto-code/harness/adapter.js';

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
import {
  setupWithKanban,
  buildHappyFactory,
} from './helpers/workflow-orchestrator-kanban-setup.js';
import { buildRecentCommentsBlock } from '../src/core/auto-code/workflows/workflow-orchestrator/escalation.js';
import { AUTO_CODE_ACTOR } from '../src/core/auto-code/actor-constants.js';

/**
 * WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (happy)
 *
 * Happy-path runs: todo→doing→done flow, pickup/boundary/done comments, cli_agent summary threading.
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator-kanban.test.ts
 * as part of the kanban describe split (Morion ticket
 * 01KRJZ1DKDRKVAV2YDDZVG3152, second pass).
 */

describe('WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (happy)', () => {
  it('happy run: todo → doing on enqueue, → done on terminal', async () => {
    const ctx = setupWithKanban();
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: buildHappyFactory(),
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('done');
    const note = ctx.notes.getById(ctx.ticketId);
    expect(note?.status).toBe('done');
  });

  it('happy run: posts pickup comment, fix→review boundary comment, done comment', async () => {
    const ctx = setupWithKanban();
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: buildHappyFactory(),
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    await out.handle.awaitTerminal();
    // Inspect comments — comments-repo lists newest-first, but the
    // test reverses for chronological narrative.
    const page = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const bodies = page.items
      .slice()
      .reverse()
      .map((c) => c.body);
    const moBodies = bodies.filter((b) =>
      page.items.find((c) => c.body === b && c.actor === 'mcp:auto-code'),
    );
    // Content-based assertions — the order between Mo comments and
    // cli_agent summary comments (📝-prefixed, added 2026-05-13)
    // depends on stage end-hook firing order. The contract this
    // test pins is "the user sees pickup + fix→review boundary +
    // done as Mo comments somewhere in the thread", regardless of
    // how many agent-summary comments interleave them.
    expect(moBodies.some((b) => /picked this up/i.test(b))).toBe(true);
    // Codex P3 (2026-05-10): copy is now template-aware + reads
    // graphSnapshot. Multi-stage default-autocode names the next
    // stage explicitly (e.g. "Starting codex (review)").
    expect(moBodies.some((b) => /Starting codex \(review\)/i.test(b))).toBe(true);
    // Done comment (updated 2026-05-11 — actionable copy points at
    // the "Merge into main" drawer button so the user knows the
    // worktree branch isn't on trunk yet).
    const doneComment = moBodies.find((b) => /Auto-code done/i.test(b));
    expect(doneComment).toBeDefined();
    expect(doneComment).toMatch(/Merge into main/);
  });

  it('posts cli_agent summaries as ticket comments (2026-05-13 fix: keeps reviewer reasoning visible + threads it into Mo recentComments context)', async () => {
    const ctx = setupWithKanban();
    // Distinct summaries per agent so we can assert each is posted.
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary:
            agent === 'claude'
              ? 'Fix complete — adjusted the score-panel grid to a stacked layout. Specific change: `.stats` grid-template-columns 1fr.'
              : '{"verdict":"approve","reason":"Looks good; the stacked layout fixes the wrap issue cleanly."}',
          costUsd: 0.4,
          terminalReason: 'completed',
          timestamp: Date.now(),
        },
      });
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    await out.handle.awaitTerminal();
    // Each cli_agent stage's summary should be a comment on the
    // ticket, headed with the stage id + agent name so the user
    // can tell who said what. Workflow has two cli_agent stages
    // (fix + review) so we expect TWO summary comments.
    const page = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const summaryComments = page.items.filter((c) =>
      c.body.startsWith('📝'),
    );
    expect(summaryComments.length).toBeGreaterThanOrEqual(2);
    // The fix summary's specific text is preserved (cap is 4000 chars).
    expect(
      summaryComments.some((c) =>
        c.body.includes('stacked layout fixes') ||
          c.body.includes('grid-template-columns 1fr'),
      ),
    ).toBe(true);
    // The review summary's verdict reason text bubbles through too.
    // (The 'approve' value is JSON-wrapped because that's how Codex
    // emits review verdicts; the comment posts the whole summary
    // string verbatim, so the reasoning text inside the JSON is
    // searchable.)
    expect(
      summaryComments.some((c) =>
        c.body.includes('stacked layout fixes the wrap'),
      ),
    ).toBe(true);
    // Each comment carries the stage-id header so Mo's downstream
    // decision can tell which stage produced which text.
    expect(summaryComments.some((c) => /^📝 \*\*.+\*\*/m.test(c.body))).toBe(true);
  });

  it('recentComments block includes auto-code comments, caps at 20 newest, clips oversize bodies', async () => {
    // "Mo = router, not narrator":
    // ticket comments are the shared agent/user channel — the old
    // AUTO_CODE_ACTOR filter is gone, replaced by deterministic caps.
    const ctx = setupWithKanban();
    const orch = buildOrchestrator(ctx, {
      runner: new WorkflowRunner({
        repo: ctx.runsRepo,
        adapterFactory: () => {
          throw new Error('not used');
        },
        transcriptDir: TRANSCRIPT_DIR,
      }),
    });

    ctx.comments.create(ctx.ticketId, 'OLDEST-should-fall-off', 'user');
    for (let i = 1; i <= 18; i++) {
      ctx.comments.create(ctx.ticketId, `user note ${i}`, 'user');
    }
    ctx.comments.create(
      ctx.ticketId,
      'Mo decided: `reopen`. Reviewer cited "missing wall-kick table".',
      AUTO_CODE_ACTOR,
    );
    ctx.comments.create(ctx.ticketId, `giant log ${'z'.repeat(2000)}`, 'user');

    const block = buildRecentCommentsBlock(orch, ctx.ticketId);
    // Auto-code's own comment is visible — it is the cross-run/agent channel.
    expect(block).toContain('missing wall-kick table');
    // 20-newest window: the 21st (oldest) comment fell off.
    expect(block).not.toContain('OLDEST-should-fall-off');
    expect(block).toContain('user note 1');
    // Oversize body clipped with an explicit marker.
    expect(block).toContain('[comment truncated]');
    expect(block).not.toContain('z'.repeat(1500));
  });

});
