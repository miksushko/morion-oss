import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  MoSpendLedgerRepository,
  MoMemoryRepository,
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';

/**
 * Regression for the POST /api/concierge/sessions/:id/messages →
 * pending-tool branch in `runMoChatLoop`. The chain we're pinning:
 *
 *   user message arrives → readProviderModel(ctx) → loop turn 1 →
 *   provider returns a destructive `notes_delete` tool call →
 *   isMoApprovalRequired() === true → persist `__MO_PENDING_TOOL_APPROVAL__`
 *   sentinel + return early (kind:'pending') → note STAYS ALIVE.
 *
 * Existing /tool-approve tests in concierge-http.test.ts pre-seed the
 * pending row directly, so they do NOT cover the loop's "stop before
 * dispatch when a delete tool call arrives" decision. This file does.
 *
 * Why this matters for the upcoming refactor: when `runMoChatLoop` is
 * extracted out of `src/server/routes/concierge.ts` into its own
 * `mo-chat-loop.ts` module (slice 8), the threading of `ALL_TOOLS` /
 * `isMoApprovalRequired` / `formatPendingToolMessage` / messages-repo
 * writes must stay correct. A regression here would silently execute
 * destructive tools without an approval gate — a security-class bug.
 */

function activatePro(_settings: SettingsRepository): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

/** Provider stub: emits ONE destructive `notes_delete` tool call on
 * the first call, an empty terminal response on subsequent calls. */
class DestructiveOnceProvider implements LLMProvider {
  readonly name = 'destructive-once-stub';
  public calls = 0;
  constructor(private readonly noteId: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "I'll clean this up.",
        toolCalls: [
          {
            id: 'call_destructive_1',
            name: 'notes_delete',
            argumentsJson: JSON.stringify({ id: this.noteId }),
          },
        ],
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.0001,
        model: req.model || 'stub',
      };
    }
    return {
      content: 'no-op',
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model || 'stub',
    };
  }
}

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  settings: SettingsRepository;
  folders: FoldersRepository;
  notes: NotesRepository;
  messages: ConciergeMessagesRepository;
  sessions: ConciergeSessionsRepository;
  provider: DestructiveOnceProvider;
  doomedNoteId: string;
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
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-pending-tool-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);

  // Pre-seed a note for the destructive call to target.
  const doomed = notes.create({ body: 'Will Mo try to delete me?', source: 'user' }, 'user');
  const provider = new DestructiveOnceProvider(doomed.id);

  const app = buildHttpApp({
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
    configDir,
    concierge: {
      folderSettings,
      sessions,
      messages: cMessages,
      moSpendLedger,
      moMemory,
      budget,
      providerOverride: provider,
    },
  });

  return {
    handle,
    app,
    settings,
    folders,
    notes,
    messages: cMessages,
    sessions,
    provider,
    doomedNoteId: doomed.id,
  };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /api/concierge/sessions/:id/messages — pending-tool branch', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('pauses on a destructive tool call: persists __MO_PENDING_TOOL_APPROVAL__ sentinel, does NOT execute the delete', async () => {
    const s = ctx.sessions.create({ openedBy: 'user' });

    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/messages`,
      json({ content: 'please remove that thing' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; role: string };
      assistant: { id: string; role: string; content: string };
    };

    // Sentinel persisted on the assistant row.
    expect(body.assistant.role).toBe('assistant');
    expect(body.assistant.content).toContain('__MO_PENDING_TOOL_APPROVAL__');

    // Payload after the marker carries the tool call so the UI can
    // render the approval card. Round-trip JSON-parse the second line.
    const afterMarker = body.assistant.content.split('\n').slice(1).join('\n');
    const payload = JSON.parse(afterMarker) as {
      toolCalls: Array<{ id: string; name: string }>;
      destructiveCallIds: string[];
    };
    expect(payload.toolCalls.map((t) => t.name)).toContain('notes_delete');
    expect(payload.destructiveCallIds).toContain('call_destructive_1');

    // The note must still be alive — pending sentinel must NOT dispatch.
    const fetched = ctx.notes.getById(ctx.doomedNoteId, { includeTrashed: true });
    expect(fetched).not.toBeNull();
    expect(fetched!.deletedAt).toBeNull();

    // Loop should have stopped after turn 1 — second provider.complete
    // would dispatch the tool result back into the loop, which is the
    // exact thing the approval gate prevents.
    expect(ctx.provider.calls).toBe(1);
  });

  it('records the pending row as the most recent assistant message in the session transcript', async () => {
    const s = ctx.sessions.create({ openedBy: 'user' });
    await ctx.app.request(
      `/api/concierge/sessions/${s.id}/messages`,
      json({ content: 'please remove that thing' }),
    );
    const transcript = ctx.messages.listBySession(s.id);
    // Expect: 1 user + 1 assistant (sentinel). No prior dispatch
    // summary row from the loop's "non-destructive turn" branch.
    expect(transcript.length).toBe(2);
    expect(transcript[0].role).toBe('user');
    expect(transcript[1].role).toBe('assistant');
    expect(transcript[1].content).toContain('__MO_PENDING_TOOL_APPROVAL__');
  });
});
