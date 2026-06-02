import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/index.js';

export interface MoTier1Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
}

export function setupMoTier1Ctx(): MoTier1Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    meta: new NoteMoMetadataRepository(handle.db),
    clusters: new NoteMoClustersRepository(handle.db),
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

export interface StubProviderOptions {
  content: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  throwError?: Error;
}

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public readonly calls: LLMRequest[] = [];

  constructor(private readonly opts: StubProviderOptions) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    if (this.opts.throwError) throw this.opts.throwError;
    return {
      content: this.opts.content,
      toolCalls: [],
      tokensIn: this.opts.tokensIn ?? 100,
      tokensOut: this.opts.tokensOut ?? 50,
      costUsd: this.opts.costUsd ?? 0.0001,
      model: req.model,
    };
  }
}

export const sampleBody = `# Bug: Mo chat history replays orphan tool messages

## Problem
After Mo uses tools, persisted history can be replayed as invalid sequences.
Strict providers reject. Need to reconstruct structured tool_calls.

## Fix
\`reconstructLLMHistory\` in chat-history.ts.`;
