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

/**
 * WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (failure / escalation)
 *
 * Failure + escalation modes: → backlog + auto-code-paused tag + Ask Mo session opening + comment-only fallback + non-escalation no-session + escalated-failed branch.
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator-kanban.test.ts
 * as part of the kanban describe split (Morion ticket
 * 01KRJZ1DKDRKVAV2YDDZVG3152, second pass).
 */

describe('WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (failure / escalation)', () => {
  it('failed run: → backlog + auto-code-paused tag + reason comment', async () => {
    const ctx = setupWithKanban();
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'error',
          errorKind: 'spawn_failed',
          message: 'binary missing',
          recoverable: false,
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
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('failed');
    const note = ctx.notes.getById(ctx.ticketId);
    expect(note?.status).toBe('backlog');
    expect(note?.tags).toContain('auto-code-paused');
    const page = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const lastMo = page.items.find((c) => c.actor === 'mcp:auto-code');
    // Humanized failure copy (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE
    // follow-up 2026-05-19): unknown sentinels surface under
    // "Auto-code stopped with an error" with the raw string fenced
    // at the end so power users can still grep / file a ticket.
    expect(lastMo?.body).toMatch(/Auto-code stopped/i);
    expect(lastMo?.body).toContain('auto-code-paused');
    expect(lastMo?.body).toMatch(/spawn_failed/);
  });

  it('escalated run with sessions wired: opens Ask Mo chat session (T7.B.2.c)', async () => {
    const ctx = setupWithKanban();
    const { ConciergeSessionsRepository } = await import(
      '../src/core/concierge/sessions-repository.ts'
    );
    const { ConciergeMessagesRepository } = await import(
      '../src/core/concierge/messages-repository.ts'
    );
    const sessions = new ConciergeSessionsRepository(ctx.db);
    const messages = new ConciergeMessagesRepository(ctx.db);
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary:
            agent === 'claude'
              ? 'fix done'
              : '{"verdict":"escalate","reason":"ticket spec is too ambiguous to act on"}',
          costUsd: 0.1,
          terminalReason: 'completed',
          timestamp: Date.now(),
        },
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
      sessions,
      messages,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {},
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('failed');
    // A session was created with the auto-code-paused triage shape.
    const sessionRows = sessions.list({ limit: 10 }).filter((s) => s.folderId === ctx.folderId);
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].title).toMatch(/Auto-code paused/);
    expect(sessionRows[0].needsHuman).toBe(true);
    expect(sessionRows[0].openedBy).toBe('concierge');
    // The session has the assistant message carrying the
    // reviewer's reason verbatim.
    const msgs = messages.listBySession(sessionRows[0].id, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toMatch(/ticket spec is too ambiguous/);
    // The ticket comment mentions the chat session.
    const commentPage = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const lastMo = commentPage.items.find((c) => c.actor === 'mcp:auto-code');
    expect(lastMo?.body).toMatch(/Opened Ask Mo chat session/);
  });

  it('escalated run WITHOUT sessions wired: falls back to comment-only', async () => {
    const ctx = setupWithKanban();
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary:
            agent === 'claude'
              ? 'fix done'
              : '{"verdict":"escalate","reason":"unclear"}',
          costUsd: 0.1,
          terminalReason: 'completed',
          timestamp: Date.now(),
        },
      });
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    // No sessions/messages injected.
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('failed');
    // Comment still posted; no "Opened Ask Mo" line because no
    // session was created.
    const commentPage = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const lastMo = commentPage.items.find((c) => c.actor === 'mcp:auto-code');
    expect(lastMo?.body).toMatch(/Auto-code paused — reviewer escalated/);
    expect(lastMo?.body).not.toMatch(/Opened Ask Mo/);
  });

  it('non-escalation failure: NO session opened (only comment)', async () => {
    const ctx = setupWithKanban();
    const { ConciergeSessionsRepository } = await import(
      '../src/core/concierge/sessions-repository.ts'
    );
    const { ConciergeMessagesRepository } = await import(
      '../src/core/concierge/messages-repository.ts'
    );
    const sessions = new ConciergeSessionsRepository(ctx.db);
    const messages = new ConciergeMessagesRepository(ctx.db);
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'error',
          errorKind: 'spawn_failed',
          message: 'binary missing',
          recoverable: false,
          timestamp: Date.now(),
        },
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
      sessions,
      messages,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {},
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('failed');
    // No session — `spawn_failed` is a config bug, not a question
    // for the user to answer in chat.
    expect(sessions.list({ limit: 10 }).filter((s) => s.folderId === ctx.folderId)).toHaveLength(0);
  });

  it('escalated run: failed branch fires (lastError carries escalated_by_review)', async () => {
    const ctx = setupWithKanban();
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary:
            agent === 'claude'
              ? 'fix done'
              : '{"verdict":"escalate","reason":"ambiguous spec"}',
          costUsd: 0.1,
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
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toMatch(/escalated_by_review/);
    const note = ctx.notes.getById(ctx.ticketId);
    expect(note?.status).toBe('backlog');
    expect(note?.tags).toContain('auto-code-paused');
  });

  // ---- Codex T7.B.2.b review regressions -----------------------------

});
