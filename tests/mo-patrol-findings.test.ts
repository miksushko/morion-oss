import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  BudgetTracker,
  MoPatrolFindingsRepository,
  appendFindings,
  type Tier0Finding,
} from '../src/core/concierge/index.js';
import { moAcknowledgeFindingTool } from '../src/server/tools/mo/mo_acknowledge_finding.js';
import type { ToolContext } from '../src/server/tools/types.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  findings: MoPatrolFindingsRepository;
  toolCtx: ToolContext;
  settings: SettingsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const findings = new MoPatrolFindingsRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);

  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: ledger,
    moMemory: new MoMemoryRepository(settings),
    budget: new BudgetTracker(ledger),
    moPatrolFindings: findings,
  };

  const configDir = mkdtempSync(join(tmpdir(), 'morion-mo-findings-'));
  const toolCtx: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    search,
    indexer,
    audit,
    settings,
    actor: 'mcp:test',
    configDir,
    concierge,
  };

  return { handle, notes, folders, findings, toolCtx, settings };
}

function mkNoteId(ctx: Ctx, folderId: string, title: string): string {
  const note = ctx.notes.create(
    { body: `# ${title}\n\nA placeholder body for the test fixture.`, folderId, source: 'user' },
    'user',
  );
  return note.id;
}

const f = (kind: string, noteId: string, sev: Tier0Finding['severity'] = 'p2'): Tier0Finding => ({
  kind: kind as Tier0Finding['kind'],
  severity: sev,
  noteId,
  noteTitle: 'T',
  message: `${kind} test`,
  context: { ageDays: 12 },
});

describe('MoPatrolFindingsRepository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('insertBatch returns ids in order; rows default to state=open', () => {
    const folder = ctx.folders.create('F');
    const n1 = mkNoteId(ctx, folder.id, 'N1');
    const n2 = mkNoteId(ctx, folder.id, 'N2');
    const ids = ctx.findings.insertBatch(folder.id, [
      f('stuck_doing', n1),
      f('no_tags', n2, 'info'),
    ]);
    expect(ids).toHaveLength(2);
    const a = ctx.findings.get(ids[0]!);
    const b = ctx.findings.get(ids[1]!);
    expect(a?.state).toBe('open');
    expect(b?.findingKind).toBe('no_tags');
  });

  it('setState transitions open → accepted / dismissed / snoozed', () => {
    const folder = ctx.folders.create('F');
    const noteId = mkNoteId(ctx, folder.id, 'N');
    const [id] = ctx.findings.insertBatch(folder.id, [f('stuck_doing', noteId)]);
    ctx.findings.setState(id!, 'accept');
    expect(ctx.findings.get(id!)?.state).toBe('accepted');
    ctx.findings.setState(id!, 'dismiss');
    expect(ctx.findings.get(id!)?.state).toBe('dismissed');
    ctx.findings.setState(id!, 'snooze', { snoozeUntil: 5000 });
    const snoozed = ctx.findings.get(id!);
    expect(snoozed?.state).toBe('snoozed');
    expect(snoozed?.snoozeUntil).toBe(5000);
  });

  it('listOpen includes open + expired-snooze rows; excludes accepted / dismissed / active-snooze', () => {
    const folder = ctx.folders.create('F');
    const ids = ctx.findings.insertBatch(folder.id, [
      f('a', mkNoteId(ctx, folder.id, 'A')),
      f('b', mkNoteId(ctx, folder.id, 'B')),
      f('c', mkNoteId(ctx, folder.id, 'C')),
      f('d', mkNoteId(ctx, folder.id, 'D')),
    ]);
    // Leave [0] open. Accept [1]. Dismiss [2]. Snooze [3] until t=5000.
    ctx.findings.setState(ids[1]!, 'accept');
    ctx.findings.setState(ids[2]!, 'dismiss');
    ctx.findings.setState(ids[3]!, 'snooze', { snoozeUntil: 5000 });

    // Read at t=4000 → only [0] is open.
    const earlier = ctx.findings.listOpen(folder.id, 4000);
    expect(earlier.map((r) => r.findingKind).sort()).toEqual(['a']);

    // Read at t=6000 → snooze expired → [3] also open.
    const later = ctx.findings.listOpen(folder.id, 6000);
    expect(later.map((r) => r.findingKind).sort()).toEqual(['a', 'd']);
  });

  it('hasOpenSimilar dedups across re-detection (kind + note + folder)', () => {
    const folder = ctx.folders.create('F');
    const noteId = mkNoteId(ctx, folder.id, 'N');
    ctx.findings.insertBatch(folder.id, [f('stuck_doing', noteId)]);
    expect(
      ctx.findings.hasOpenSimilar(folder.id, noteId, 'stuck_doing'),
    ).toBe(true);
    expect(ctx.findings.hasOpenSimilar(folder.id, noteId, 'no_tags')).toBe(
      false,
    );
    const otherNote = mkNoteId(ctx, folder.id, 'OTHER');
    expect(
      ctx.findings.hasOpenSimilar(folder.id, otherNote, 'stuck_doing'),
    ).toBe(false);
  });
});

describe('appendFindings — Phase 5d table integration', () => {
  it('writes to mo_patrol_findings when findingsRepo is supplied', () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    const a = mkNoteId(ctx, folder.id, 'A');
    const b = mkNoteId(ctx, folder.id, 'B');
    const result = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [f('stuck_doing', a), f('no_tags', b, 'info')],
      { findingsRepo: ctx.findings },
    );
    expect(result.appended).toBe(2);
    expect(result.findingIds).toHaveLength(2);
    const stored = ctx.findings.listOpen(folder.id);
    expect(stored).toHaveLength(2);
  });

  it('skips table writes when findingsRepo is omitted (back-compat)', () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    const a = mkNoteId(ctx, folder.id, 'A');
    const result = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [f('stuck_doing', a)],
    );
    expect(result.findingIds).toEqual([]);
    expect(ctx.findings.listOpen(folder.id)).toHaveLength(0);
  });
});

describe('mo_acknowledge_finding — gates + transitions', () => {
  it('returns finding_not_found for an unknown id', async () => {
    const ctx = setup();
    const result = (await moAcknowledgeFindingTool.handler(
      { findingId: 'does-not-exist', action: 'dismiss' },
      ctx.toolCtx,
    )) as { error?: string };
    expect(result.error).toBe('finding_not_found');
  });

  it('snooze without snoozeUntilTs returns mo_invalid_input', async () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const noteId = mkNoteId(ctx, folder.id, 'A');
    const [id] = ctx.findings.insertBatch(folder.id, [
      f('stuck_doing', noteId),
    ]);

    const result = (await moAcknowledgeFindingTool.handler(
      { findingId: id!, action: 'snooze' },
      ctx.toolCtx,
    )) as { error?: string; reason?: string };
    expect(result.error).toBe('mo_invalid_input');
    expect(result.reason).toBe('snooze_requires_timestamp');
  });

  it('accept transitions state to accepted', async () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const noteId = mkNoteId(ctx, folder.id, 'A');
    const [id] = ctx.findings.insertBatch(folder.id, [
      f('stuck_doing', noteId),
    ]);

    const result = (await moAcknowledgeFindingTool.handler(
      { findingId: id!, action: 'accept' },
      ctx.toolCtx,
    )) as { state?: string };
    expect(result.state).toBe('accepted');
  });

  it('snooze with timestamp persists snoozeUntil', async () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const noteId = mkNoteId(ctx, folder.id, 'A');
    const [id] = ctx.findings.insertBatch(folder.id, [
      f('stuck_doing', noteId),
    ]);

    const result = (await moAcknowledgeFindingTool.handler(
      { findingId: id!, action: 'snooze', snoozeUntilTs: 9_999_999_999 },
      ctx.toolCtx,
    )) as { state?: string; snoozeUntil?: number | null };
    expect(result.state).toBe('snoozed');
    expect(result.snoozeUntil).toBe(9_999_999_999);
  });
});
