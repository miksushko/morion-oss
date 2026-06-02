import { describe, it, expect, beforeEach } from 'vitest';
import { runTier1ForNote } from '../../src/core/concierge/index.js';
import {
  setupMoTier1Ctx,
  StubProvider,
  sampleBody,
  type MoTier1Ctx,
} from '../helpers/mo-tier1-setup.js';

describe('runTier1ForNote — short-circuits', () => {
  let ctx: MoTier1Ctx;
  beforeEach(() => {
    ctx = setupMoTier1Ctx();
  });

  it('returns fresh / hands_off when mo_hands_off is set', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.setHandsOff(note.id, true);

    const provider = new StubProvider({ content: '{}' });
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        model: 'm',
      },
      note.id,
    );
    expect(result.status).toBe('fresh');
    if (result.status !== 'fresh') return;
    expect(result.reason).toBe('hands_off');
    expect(provider.calls).toHaveLength(0);
  });

  it('returns fresh / empty_body when body is too short', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# Stub', folderId: folder.id, source: 'user' },
      'user',
    );
    const provider = new StubProvider({ content: '{}' });
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        model: 'm',
      },
      note.id,
    );
    expect(result.status).toBe('fresh');
    if (result.status !== 'fresh') return;
    expect(result.reason).toBe('empty_body');
  });

  it('returns error / note_not_found when noteId is unknown', async () => {
    const provider = new StubProvider({ content: '{}' });
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        model: 'm',
      },
      'does-not-exist',
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('note_not_found');
  });
});
