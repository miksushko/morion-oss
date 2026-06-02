import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  renderClusterSection,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/index.js';

export interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
}

export function setup(): Ctx {
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

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public calls: LLMRequest[] = [];
  constructor(
    private readonly responder: (req: LLMRequest) => Promise<LLMResponse>,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return this.responder(req);
  }
}

export function tier2Body(opts?: {
  overview?: string;
  state?: string;
  open?: string;
  notes?: string;
}): string {
  return [
    renderClusterSection('overview', opts?.overview ?? 'Mo-written overview.'),
    renderClusterSection('state', opts?.state ?? '- 5 tickets total\n- 3 done'),
    renderClusterSection('open', opts?.open ?? '- One backlog item'),
    renderClusterSection('notes', opts?.notes ?? '- 01ABC… first\n- 01DEF… second'),
  ].join('\n\n');
}

export const sampleNoteBody = (tag: string): string =>
  `# ${tag}\n\nA full ticket body for cluster context with substantive content.`;
