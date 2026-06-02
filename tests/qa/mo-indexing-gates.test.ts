import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runMoIndexingTick,
  hashBody,
  ensurePatrolLogNote,
  appendFindings,
  runTier0Checks,
  drainTier1Queue,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  CONCIERGE_ACTOR as MO_ACTOR,
} from '../../src/core/concierge/index.js';
import {
  buildIndexingDeps,
  defaultProvider,
  longBody,
  setupQa,
  StubProvider,
  tier1Json,
  type QaCtx,
  type StubResponseSpec,
} from '../helpers/mo-indexing-setup.js';

/**
 * QA — Mo Indexing gates — what prevents the pipeline from picking up a note.
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-phase1-2.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9, second pass).
 */

describe('QA — Mo Indexing gates (backend / folder / archive / mo_hands_off / feedback-loop)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 1: Backend gate — wrong backend → gated_off', async () => {
    qa.rt.settings.set('concierge.backend', 'groq');
    qa.rt.settings.set('concierge.groq_api_key', 'real-key');
    const folder = qa.rt.folders.create('F1');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );

    const stub = new StubProvider(() => ({ content: tier1Json }));
    // Simulate the production resolver — returns null for non-openrouter.
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => null),
    );
    expect(summary.status).toBe('gated_off');
    expect(stub.calls).toHaveLength(0);
    expect(qa.rt.settings.get(MO_INDEXING_AUDIT_CHECKPOINT_KEY, 0)).toBe(0);
  });

  it('Case 2: OpenRouter without key → gated_off', async () => {
    qa.rt.settings.set('concierge.backend', 'openrouter');
    // No openrouter_api_key set.
    const folder = qa.rt.folders.create('F2');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => null),
    );
    expect(summary.status).toBe('gated_off');
  });


  it('Case 7: Feedback-loop guard — Mo-actor writes on mo:* notes skipped', async () => {
    // Both step 1 (audit_log poll) and step 1.5 (bootstrap sweep)
    // exclude mo:* system notes via `n.source NOT LIKE 'mo:%'`. Step 1
    // additionally excludes audit rows from actor=morion-concierge as
    // belt-and-braces. Together they guarantee Mo's own appends to
    // mo:patrol-log / mo:cluster:* / mo:catalog never re-enqueue.
    const folder = qa.rt.folders.create('Loop');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      {
        body: '# Patrol log\n\n_Mo will append findings here._',
        folderId: folder.id,
        source: 'mo:patrol-log',
      },
      MO_ACTOR,
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('Case 8: Folder Mo-disabled → not enqueued', async () => {
    const folder = qa.rt.folders.create('Disabled');
    // No concierge_folder_settings row → INNER JOIN drops.
    qa.rt.notes.create(
      { body: longBody('off'), folderId: folder.id, source: 'user' },
      'user',
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('Case 9: Archived folder → not enqueued', async () => {
    const folder = qa.rt.folders.create('ArchFolder');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('inside-archived'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.handle.db
      .prepare('UPDATE folders SET archived_at = ? WHERE id = ?')
      .run(Date.now(), folder.id);
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(0);
  });

  it('Case 10: Archived note skipped, sibling processed', async () => {
    const folder = qa.rt.folders.create('Mixed');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const archived = qa.rt.notes.create(
      { body: longBody('archived'), folderId: folder.id, source: 'user' },
      'user',
    );
    const live = qa.rt.notes.create(
      { body: longBody('live'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), archived.id);

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(1);
    expect(qa.rt.concierge.moMetadata.get(archived.id)).toBeNull();
    expect(qa.rt.concierge.moMetadata.get(live.id)).not.toBeNull();
  });

  it('Case 11: mo_hands_off → LLM skipped on that note', async () => {
    const folder = qa.rt.folders.create('Hands');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const protectedNote = qa.rt.notes.create(
      { body: longBody('protected'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.concierge.moMetadata.setHandsOff(protectedNote.id, true);

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    // Still enqueued (subscriber doesn't see the flag), but the worker
    // returns 'fresh / hands_off' without an LLM call.
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.fresh).toBe(1);
    expect(summary.worker?.computed).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

});
