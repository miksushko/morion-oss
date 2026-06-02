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
 * QA — Mo Indexing Tier 0 — pure-SQL deterministic checks + mo:patrol-log lifecycle (no LLM).
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-phase1-2.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9, second pass).
 */

describe('QA — Mo Indexing Tier 0 (deterministic checks + patrol log)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 15: Tier 0 deterministic checks (no LLM, pure SQL)', async () => {
    const folder = qa.rt.folders.create('Tier0');
    const stuckDoing = qa.rt.notes.create(
      {
        body: '# Stuck\n\nA ticket parked in doing for too long without an update.',
        folderId: folder.id,
        source: 'user',
        status: 'doing',
      },
      'user',
    );
    qa.rt.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 30 * 24 * 60 * 60 * 1000, stuckDoing.id);
    const shortStub = qa.rt.notes.create(
      { body: '# x', folderId: folder.id, source: 'user' },
      'user',
    );
    const broken = qa.rt.notes.create(
      { body: '~~scrapped~~\n\nReplacement direction.', folderId: folder.id, source: 'user' },
      'user',
    );
    const findings = runTier0Checks(qa.rt.handle.db, folder.id);
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds.has('stuck_doing')).toBe(true);
    expect(kinds.has('short_body')).toBe(true);
    expect(kinds.has('broken_title_strikethrough')).toBe(true);
    void shortStub;
    void broken;
  });

  it('Case 16: mo:patrol-log lifecycle — ensure + 2 appends', async () => {
    const folder = qa.rt.folders.create('Patrol');
    const t1 = Date.UTC(2026, 3, 28, 9, 0);
    const t2 = Date.UTC(2026, 3, 28, 11, 0);
    const ensured = ensurePatrolLogNote(qa.rt.handle.db, qa.rt.notes, folder.id);
    expect(ensured.source).toBe('mo:patrol-log');
    appendFindings(
      qa.rt.handle.db,
      qa.rt.notes,
      folder.id,
      [{ kind: 'stuck_doing', severity: 'p2', noteId: '01ABC', noteTitle: 'A', message: 'aged', context: {} }],
      { now: t1 },
    );
    const second = appendFindings(
      qa.rt.handle.db,
      qa.rt.notes,
      folder.id,
      [{ kind: 'no_tags', severity: 'info', noteId: '01DEF', noteTitle: 'B', message: 'no tags', context: {} }],
      { now: t2 },
    );
    expect(second.note.body).toContain('## 2026-04-28 09:00 UTC');
    expect(second.note.body).toContain('## 2026-04-28 11:00 UTC');
    // Audit rows: 1 create + 2 updates.
    const auditCount = qa.rt.handle.db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM audit_log WHERE note_id = ?')
      .get(second.note.id);
    expect(auditCount?.c).toBe(3);
  });

});
