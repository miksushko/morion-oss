/**
 * Regression: Mo "Used tool, then disappeared" bug, second round
 * (umbrella ticket 01KQ1R97C0GK6KPQF03AFCZ42B).
 *
 * The user reproduced the original bug AFTER the first fix landed:
 * Mo deletes 10 tags (server cap), the user types "продолжать", and
 * Mo's next /messages call appears to hit the model and then vanish
 * with no follow-up assistant text.
 *
 * Hypothesis under test: when /messages re-feeds the prior transcript
 * back to the provider, it does NOT reconstruct the structured
 * `tool_calls` field on assistant turns that emitted tool calls in a
 * previous round. The DB only stores a text marker like
 * `(querying workspace:\n- tags_list({}))` on those assistant rows,
 * and the structured tool-calls JSON for pending rows. Tool messages
 * with `tool_call_id` are persisted, but their parent assistant row
 * has no `tool_calls`. OpenAI-compatible providers (Groq) require
 * tool messages to follow an assistant with matching `tool_calls`,
 * and either reject the request OR silently misinterpret it — both
 * symptoms match "Mo vanished".
 *
 * This test confirms the broken contract by injecting a transcript
 * that mimics a real post-approval state and inspecting the messages
 * the provider stub receives on the next /messages call.
 */
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
  PENDING_TOOL_MARKER,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';


function activatePro(_settings: SettingsRepository): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

/**
 * Stub provider that records every incoming message array so the test
 * can inspect what the chat loop fed to the model. Returns scripted
 * responses based on the call count.
 */
class RecordingProvider implements LLMProvider {
  readonly name = 'recording';
  readonly seenRequests: LLMRequest[] = [];
  constructor(private readonly responses: LLMResponse[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.seenRequests.push({
      model: req.model,
      messages: req.messages.map((m) => ({ ...m })),
      tools: req.tools,
      temperature: req.temperature,
    });
    const idx = this.seenRequests.length - 1;
    if (idx >= this.responses.length) {
      return {
        content: '(stub: no more responses)',
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: req.model,
      };
    }
    return this.responses[idx]!;
  }
}

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  settings: SettingsRepository;
  notes: NotesRepository;
  tags: TagsRepository;
  concierge: {
    folderSettings: ConciergeFolderSettingsRepository;
    sessions: ConciergeSessionsRepository;
    messages: ConciergeMessagesRepository;
    budget: BudgetTracker;
  };
}

function setup(provider: LLMProvider): Ctx {
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-mo-history-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);

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
      // Test-only injection — bypasses Groq/OpenRouter resolution.
      providerOverride: provider,
    },
  });

  return {
    handle,
    app,
    settings,
    notes,
    tags,
    concierge: {
      folderSettings,
      sessions,
      messages: cMessages,
      budget,
    },
  };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Mo chat history reconstruction (01KQ1R97C0GK6KPQF03AFCZ42B round 2)', () => {
  let ctx: Ctx;
  let provider: RecordingProvider;

  beforeEach(() => {
    // Scripted provider responses. We chain three turns:
    //   1. /messages turn — emit `tags_list({})`
    //   2. continuation turn (after dispatch) — emit no tools, finish.
    //   3. follow-up /messages turn for "продолжать" — emit `tags_list({})`
    //   4. continuation — finish.
    provider = new RecordingProvider([
      // Turn 1: model wants tags_list
      {
        content: '',
        toolCalls: [
          { id: 'call_list_1', name: 'tags_list', argumentsJson: '{}' },
        ],
        tokensIn: 50,
        tokensOut: 5,
        costUsd: 0,
        model: 'stub',
      },
      // Turn 2: model finishes round 1
      {
        content: 'Found 3 tags. Want me to delete any?',
        toolCalls: [],
        tokensIn: 60,
        tokensOut: 20,
        costUsd: 0,
        model: 'stub',
      },
      // Turn 3 (new /messages — "продолжать"): model wants tags_list again
      {
        content: '',
        toolCalls: [
          { id: 'call_list_2', name: 'tags_list', argumentsJson: '{}' },
        ],
        tokensIn: 80,
        tokensOut: 5,
        costUsd: 0,
        model: 'stub',
      },
      // Turn 4: model finishes round 2
      {
        content: 'Now I see 3 tags. Confirm to delete.',
        toolCalls: [],
        tokensIn: 90,
        tokensOut: 20,
        costUsd: 0,
        model: 'stub',
      },
    ]);
    ctx = setup(provider);
    activatePro(ctx.settings);
    // Seed tags so dispatch returns real data, not just empty list.
    ctx.tags.upsertByName('alpha');
    ctx.tags.upsertByName('beta');
    ctx.tags.upsertByName('gamma');
  });

  it('reconstructs structured tool_calls on assistant rows when re-feeding history', async () => {
    const session = ctx.concierge.sessions.create({ openedBy: 'user' });

    // Round 1 — user asks Mo to look at tags.
    const r1 = await ctx.app.request(
      `/api/concierge/sessions/${session.id}/messages`,
      json({ content: 'list my tags' }),
    );
    expect(r1.status).toBe(200);

    // After round 1 the provider has been called twice — once for the
    // initial turn (emit tags_list) and once for the continuation
    // (terminal, no tools). Both should have a clean message history.
    expect(provider.seenRequests.length).toBe(2);

    // Final assistant message MUST be persisted in the DB.
    const round1Transcript = ctx.concierge.messages.listBySession(session.id);
    const lastAssistant = [...round1Transcript]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toContain('Found 3 tags');

    // Round 2 — user types "продолжать". This is the path the user
    // reported as broken. The provider's third call should receive a
    // history where the round-1 tool-calling assistant turn carries a
    // structured `toolCalls` field, not just text content.
    const r2 = await ctx.app.request(
      `/api/concierge/sessions/${session.id}/messages`,
      json({ content: 'продолжать' }),
    );
    expect(r2.status).toBe(200);

    // Provider must have been called twice more (one tool turn + one
    // terminal turn) for round 2.
    expect(provider.seenRequests.length).toBe(4);

    const r2InitialMessages = provider.seenRequests[2]!.messages;

    // Look for the round-1 assistant tool-calling turn in the
    // re-fed history. Find the tool message with id 'call_list_1';
    // its preceding assistant turn MUST carry toolCalls=[{id:
    // 'call_list_1', name: 'tags_list', ...}] for the provider to
    // accept the request as well-formed.
    const toolIdx = r2InitialMessages.findIndex(
      (m) => m.role === 'tool' && m.toolCallId === 'call_list_1',
    );
    expect(toolIdx).toBeGreaterThan(0);

    const parentAssistant = r2InitialMessages
      .slice(0, toolIdx)
      .reverse()
      .find((m: LLMMessage) => m.role === 'assistant');
    expect(parentAssistant).toBeDefined();

    // THIS is the assertion that pins the bug. If the history
    // reconstruction is broken, parentAssistant.toolCalls is undefined
    // and the provider gets a malformed sequence (orphan tool message).
    expect(parentAssistant!.toolCalls).toBeDefined();
    const matching = (parentAssistant!.toolCalls ?? []).find(
      (c) => c.id === 'call_list_1',
    );
    expect(matching).toBeDefined();
    expect(matching!.name).toBe('tags_list');
  });

  it('always persists a final assistant message after /messages, even on empty content', async () => {
    // Replace responses so the chain produces an empty terminal turn
    // that exercises the summary-fallback code path.
    provider = new RecordingProvider([
      // Tool call
      {
        content: '',
        toolCalls: [
          { id: 'call_list_x', name: 'tags_list', argumentsJson: '{}' },
        ],
        tokensIn: 5,
        tokensOut: 0,
        costUsd: 0,
        model: 'stub',
      },
      // Terminal: empty content + no tools — exercises the loop's
      // "no terminal text → ask one more time with tools=[]" branch.
      {
        content: '',
        toolCalls: [],
        tokensIn: 5,
        tokensOut: 0,
        costUsd: 0,
        model: 'stub',
      },
      // Summary fallback call (tools=[]) returns text.
      {
        content: 'Wrap-up text from summary call.',
        toolCalls: [],
        tokensIn: 5,
        tokensOut: 5,
        costUsd: 0,
        model: 'stub',
      },
    ]);
    ctx = setup(provider);
    activatePro(ctx.settings);
    ctx.tags.upsertByName('alpha');

    const session = ctx.concierge.sessions.create({ openedBy: 'user' });
    const r = await ctx.app.request(
      `/api/concierge/sessions/${session.id}/messages`,
      json({ content: 'list my tags' }),
    );
    expect(r.status).toBe(200);

    const transcript = ctx.concierge.messages.listBySession(session.id);
    const lastAssistant = [...transcript]
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    // Either the summary text OR the static fallback — never empty.
    expect(lastAssistant!.content.length).toBeGreaterThan(0);
  });

  // PENDING_TOOL_MARKER is exercised by the existing /tool-approve
  // tests. Pull it into the import so the type narrowing above stays
  // honest; reference it here so the import isn't dead.
  it('pending tool marker constant is in scope', () => {
    expect(typeof PENDING_TOOL_MARKER).toBe('string');
  });
});
