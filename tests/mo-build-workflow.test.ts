import { beforeEach, describe, expect, it } from 'vitest';
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
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src/core/concierge/index.js';
import type { ToolContext } from '../src/server/tools/types.js';
import { moBuildWorkflowTool } from '../src/server/tools/plugins/auto-code.js';
import { buildWorkflowDraft } from '../src/core/auto-code/workflows/build-workflow.js';
import {
  DEFAULT_AUTOCODE_DEFINITION,
  LEGACY_LINEAR_AUTOCODE_DEFINITION,
} from '../src/core/auto-code/workflows/default-autocode.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import type { WorkflowDefinition, WorkflowRow } from '../src/core/auto-code/workflows/types/index.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';

/**
 * `mo_build_workflow` + its drafting engine — Mo Workflows epic.
 *
 * Draft-first contract (the mo_record lesson): the LLM path never
 * writes; the write path never calls the LLM.
 */

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  calls: LLMRequest[] = [];
  responseFor: ((req: LLMRequest, idx: number) => Partial<LLMResponse>) | null = null;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const idx = this.calls.length;
    this.calls.push(req);
    const partial = this.responseFor ? this.responseFor(req, idx) : {};
    return {
      content: 'stub default',
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 20,
      costUsd: 0.01,
      model: req.model,
      ...partial,
    };
  }
}

const VALID_DEF_JSON = JSON.stringify(LEGACY_LINEAR_AUTOCODE_DEFINITION);

interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
  folderSettings: ConciergeFolderSettingsRepository;
  ledger: MoSpendLedgerRepository;
  provider: StubProvider;
}

function setup(actor = 'mcp:test-client'): Ctx {
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
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const messages = new ConciergeMessagesRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(ledger);
  const provider = new StubProvider();
  const tc: ToolContext = {
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
    actor,
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-build-wf-')),
    concierge: {
      folderSettings,
      sessions,
      messages,
      moSpendLedger: ledger,
      moMemory,
      budget,
      providerOverride: provider,
    },
  };
  return { handle, tc, folderSettings, ledger, provider };
}

function setupMoFolder(): { ctx: Ctx; folderId: string } {
  const ctx = setup();
  const folder = ctx.tc.folders.create('Project A');
  ctx.folderSettings.update(folder.id, { enabled: true });
  return { ctx, folderId: folder.id };
}

// ---------------------------------------------------------------------
// Engine (pure, fake provider)
// ---------------------------------------------------------------------

describe('buildWorkflowDraft engine', () => {
  it('accepts a valid draft on the first attempt', async () => {
    const provider = new StubProvider();
    provider.responseFor = () => ({ content: VALID_DEF_JSON });
    const res = await buildWorkflowDraft({
      provider,
      primaryModel: 'primary-x',
      fallbackModel: '',
      instruction: 'two agent flow',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(1);
      expect(res.runnable).toBe(true);
      expect(res.costUsd).toBeCloseTo(0.01);
      expect(res.modelUsed).toBe('primary-x');
    }
  });

  it('feeds validation issues back and succeeds on retry', async () => {
    const provider = new StubProvider();
    const broken = structuredClone(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    ) as WorkflowDefinition;
    broken.stages[1].id = broken.stages[0].id; // duplicate ids
    provider.responseFor = (_req, idx) => ({
      content: idx === 0 ? JSON.stringify(broken) : VALID_DEF_JSON,
    });
    const res = await buildWorkflowDraft({
      provider,
      primaryModel: 'primary-x',
      fallbackModel: '',
      instruction: 'fix the flow',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
    // The retry prompt carried the validation issues.
    const retryMessages = provider.calls[1].messages;
    const lastUser = retryMessages[retryMessages.length - 1];
    expect(lastUser.content).toContain('Validation failed');
  });

  it('caps attempts, switches to the fallback model on the last one, reports issues', async () => {
    const provider = new StubProvider();
    provider.responseFor = () => ({ content: 'not json at all' });
    const res = await buildWorkflowDraft({
      provider,
      primaryModel: 'primary-x',
      fallbackModel: 'fallback-y',
      instruction: 'impossible',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3);
      expect(res.issues.length).toBeGreaterThan(0);
      expect(res.costUsd).toBeCloseTo(0.03);
    }
    expect(provider.calls.map((c) => c.model)).toEqual([
      'primary-x',
      'primary-x',
      'fallback-y',
    ]);
  });

  it('extracts JSON from fenced / prose-wrapped output', async () => {
    const provider = new StubProvider();
    provider.responseFor = () => ({
      content: 'Here is the workflow:\n```json\n' + VALID_DEF_JSON + '\n```\nDone.',
    });
    const res = await buildWorkflowDraft({
      provider,
      primaryModel: 'p',
      fallbackModel: '',
      instruction: 'x',
    });
    expect(res.ok).toBe(true);
  });

  it('flags a saveable-but-not-runnable draft (branch stage) without failing', async () => {
    const provider = new StubProvider();
    const withBranch = structuredClone(
      DEFAULT_AUTOCODE_DEFINITION,
    ) as WorkflowDefinition;
    withBranch.stages.push({
      id: 'b1',
      kind: 'branch',
      combinator: 'all',
      conditions: [{ field: 'status', op: 'eq', value: 'todo' }],
    } as WorkflowDefinition['stages'][number]);
    provider.responseFor = () => ({ content: JSON.stringify(withBranch) });
    const res = await buildWorkflowDraft({
      provider,
      primaryModel: 'p',
      fallbackModel: '',
      instruction: 'x',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runnable).toBe(false);
      expect(res.runnableReason).toContain('branch');
    }
  });
});

// ---------------------------------------------------------------------
// MCP tool (gates + draft-first + write path)
// ---------------------------------------------------------------------

interface ToolResult {
  ok?: boolean;
  written?: boolean;
  definition?: WorkflowDefinition;
  workflow?: WorkflowRow;
  validation?: { runnable: boolean };
  costUsd?: number;
  error?: string;
  reason?: string;
  message?: string;
}

describe('MCP tools — mo_build_workflow', () => {
  let ctx: Ctx;
  let folderId: string;

  beforeEach(() => {
    ({ ctx, folderId } = setupMoFolder());
  });

  it('draft path returns the definition and writes NOTHING to the DB', async () => {
    ctx.provider.responseFor = () => ({ content: VALID_DEF_JSON });
    const res = (await moBuildWorkflowTool.handler(
      { folderId, instruction: 'code then review' },
      ctx.tc,
    )) as ToolResult;

    expect(res.ok).toBe(true);
    expect(res.written).toBe(false);
    expect(res.definition?.stages.length).toBeGreaterThan(0);
    expect(res.validation?.runnable).toBe(true);
    // Draft-first: no workflow row created.
    expect(
      new WorkflowsRepository(ctx.handle.db).listForFolder(folderId).length,
    ).toBe(0);
    // Spend recorded against the Mo bucket.
    expect(ctx.ledger.monthlyTotalUsd()).toBeGreaterThan(0);
    expect(ctx.ledger.monthlyBreakdown().mo_tool).toBeGreaterThan(0);
  });

  it('write path saves deterministically without any LLM call', async () => {
    const res = (await moBuildWorkflowTool.handler(
      {
        folderId,
        write: true,
        name: 'Approved by human',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      ctx.tc,
    )) as ToolResult;

    expect(res.ok).toBe(true);
    expect(res.written).toBe(true);
    expect(res.workflow?.name).toBe('Approved by human');
    expect(ctx.provider.calls.length).toBe(0); // no LLM on write
    // Audited as a workflow create with the calling actor.
    const audit = ctx.tc.audit.recent(10) as AuditRecentEntry[];
    expect(
      audit.some(
        (r) => r.action === 'workflow_create' && r.noteId === res.workflow?.id,
      ),
    ).toBe(true);
  });

  it('write: true without a definition returns definition_required', async () => {
    const res = (await moBuildWorkflowTool.handler(
      { folderId, write: true },
      ctx.tc,
    )) as ToolResult;
    expect(res.error).toBe('definition_required');
  });

  it('draft without instruction returns instruction_required', async () => {
    const res = (await moBuildWorkflowTool.handler(
      { folderId },
      ctx.tc,
    )) as ToolResult;
    expect(res.error).toBe('instruction_required');
  });

  it('gates on Mo enablement and on the folder create permission', async () => {
    const bare = ctx.tc.folders.create('No Mo');
    const noMo = (await moBuildWorkflowTool.handler(
      { folderId: bare.id, instruction: 'x' },
      ctx.tc,
    )) as ToolResult;
    expect(noMo.error ?? noMo.reason).toBeTruthy();

    ctx.tc.folders.setMcpPermissions(folderId, {
      visible: true,
      create: false,
      update: true,
      delete: true,
    });
    const denied = (await moBuildWorkflowTool.handler(
      { folderId, instruction: 'x' },
      ctx.tc,
    )) as ToolResult;
    expect(denied.error).toBe('mcp_access_denied');
  });

  it('baseTemplateId feeds the base definition into the drafting prompt', async () => {
    ctx.provider.responseFor = () => ({ content: VALID_DEF_JSON });
    const res = (await moBuildWorkflowTool.handler(
      { folderId, instruction: 'tweak it', baseTemplateId: 'default-v2' },
      ctx.tc,
    )) as ToolResult;
    expect(res.ok).toBe(true);
    const firstUser = ctx.provider.calls[0].messages.find(
      (m) => m.role === 'user',
    );
    expect(firstUser?.content).toContain('Modify this base workflow');
    expect(firstUser?.content).toContain('mo_start');
  });

  it('unknown baseTemplateId returns workflow_not_found', async () => {
    const res = (await moBuildWorkflowTool.handler(
      { folderId, instruction: 'x', baseTemplateId: 'nope' },
      ctx.tc,
    )) as ToolResult;
    expect(res.error).toBe('workflow_not_found');
  });
});
