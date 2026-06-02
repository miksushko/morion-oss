import { describe, it, expect, beforeEach } from 'vitest';
import {
  runMoIndexingTick,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  hashBody,
} from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  StubProvider,
  tier1Json,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — bootstrap sweep (ghost notes)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('enqueues notes lacking metadata even when audit_log has no fresh events', async () => {
    // Setup: folder with Mo enabled, two notes with NO audit_log
    //   activity since the indexing pipeline came online — the exact
    //   ghost-state seen in dogfooding (Coral Demo, 2026-04-28).
    //   Reproduce by inserting notes directly via the repo and then
    //   fast-forwarding the audit checkpoint past their create rows.
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const ghostA = ctx.notes.create(
      { body: longBody('ghostA'), folderId: folder.id, source: 'user' },
      'user',
    );
    const ghostB = ctx.notes.create(
      { body: longBody('ghostB'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Fast-forward the checkpoint so step 1 sees nothing — simulates
    // notes that pre-date the deployment of Phase 2c on this workspace.
    const maxAuditId = ctx.handle.db
      .prepare<[], { id: number }>('SELECT MAX(id) AS id FROM audit_log')
      .get();
    ctx.workspaceSettings.set(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      maxAuditId?.id ?? 0,
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: 'qwen/qwen3-235b-a22b-2507',
        tier2FallbackModel: null,
      }),
    );

    // Both ghost notes should have been picked up via the bootstrap
    // sweep, summarised, and persisted — same end-state as if their
    // create events had landed inside the audit window.
    expect(summary.enqueued).toBe(2);
    expect(summary.worker?.computed).toBe(2);
    expect(ctx.meta.get(ghostA.id)).not.toBeNull();
    expect(ctx.meta.get(ghostB.id)).not.toBeNull();
  });

  it('skips notes that are already queued (does not reset attempts mid-retry)', async () => {
    // Bootstrap must NOT enqueue a note that's already in the queue
    // with attempts>0 — the coalescing UPSERT would reset attempts
    // back to 0 and prevent the abandon-after-N safeguard from firing
    // on permanently broken notes.
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: longBody('busy'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Pre-seed a queue row at attempts=2 (one short of abandon).
    ctx.handle.db
      .prepare(
        `INSERT INTO mo_metadata_queue
           (folder_id, note_id, tier, body_hash, dirty_since, picked_at, attempts)
         VALUES (?, ?, 'tier1', ?, ?, NULL, 2)`,
      )
      .run(folder.id, note.id, hashBody(longBody('busy')), Date.now());
    // Fast-forward checkpoint so audit_log step is a no-op.
    const maxAuditId = ctx.handle.db
      .prepare<[], { id: number }>('SELECT MAX(id) AS id FROM audit_log')
      .get();
    ctx.workspaceSettings.set(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      maxAuditId?.id ?? 0,
    );

    const provider = new StubProvider(tier1Json);
    await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: 'qwen/qwen3-235b-a22b-2507',
        tier2FallbackModel: null,
      }),
    );
    // After the worker drained, the row is gone (success). What we
    // care about: bootstrap did NOT additionally re-enqueue and reset
    // attempts to 0 — the row went through with attempts=2 honoured.
    // Expressed as: `enqueue` was not called for this note from
    // bootstrap (provider only saw one Tier 1 request, the worker's).
    expect(provider.calls.length).toBe(1);
  });

  it('skips notes that already have metadata', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: longBody('done'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Seed metadata directly — note already processed.
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'pre-existing',
      keywords: ['x'],
      bodyHash: hashBody(longBody('done')),
      computedBy: 'tier1',
      computedAt: Date.now(),
      confidence: 0.9,
      moHandsOff: false,
    });
    const maxAuditId = ctx.handle.db
      .prepare<[], { id: number }>('SELECT MAX(id) AS id FROM audit_log')
      .get();
    ctx.workspaceSettings.set(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      maxAuditId?.id ?? 0,
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: 'qwen/qwen3-235b-a22b-2507',
        tier2FallbackModel: null,
      }),
    );
    expect(summary.enqueued).toBe(0);
    expect(provider.calls.length).toBe(0);
  });

  it('skips Mo-disabled folders, archived notes, and mo:* system notes', async () => {
    // 4 ghost notes across 4 disqualifying conditions; bootstrap
    // should pick up zero.
    const moOff = ctx.folders.create('off');
    // Mo NOT enabled on this folder.
    ctx.notes.create(
      { body: longBody('off'), folderId: moOff.id, source: 'user' },
      'user',
    );

    const moOn = ctx.folders.create('on');
    ctx.folderSettings.update(moOn.id, { enabled: true });
    // Archived note.
    const archived = ctx.notes.create(
      { body: longBody('arch'), folderId: moOn.id, source: 'user' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), archived.id);
    // mo:catalog system note (would self-summarise infinitely if
    // bootstrap caught it).
    ctx.notes.create(
      {
        body: '# Catalog skeleton\n\n_Mo will fill this in._',
        folderId: moOn.id,
        source: 'mo:catalog',
      },
      'morion-concierge',
    );

    const maxAuditId = ctx.handle.db
      .prepare<[], { id: number }>('SELECT MAX(id) AS id FROM audit_log')
      .get();
    ctx.workspaceSettings.set(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      maxAuditId?.id ?? 0,
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: 'qwen/qwen3-235b-a22b-2507',
        tier2FallbackModel: null,
      }),
    );
    expect(summary.enqueued).toBe(0);
    expect(provider.calls.length).toBe(0);
  });
});
