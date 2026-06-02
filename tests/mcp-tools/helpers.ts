/**
 * Shared setup + license helpers for the MCP tools test suite.
 *
 * The original tests/mcp-tools.test.ts (1222 LOC, 73 tests across
 * 26 nested per-tool describes) is split into per-domain test files
 * (`tests/mcp-tools-<domain>.test.ts`). Each domain file imports the
 * same `setup()` factory + Pro-license helper from here. Vitest's
 * `include: tests/**\/*.test.ts` skips this file (no `.test.ts`).
 *
 * `setup()` builds a fresh in-memory SQLite, wires every repository
 * (notes / folders / tags / revisions / attachments / comments /
 * search) + the FTS + sqlite-vec indices via NoopEmbeddings, and
 * stamps a temp config dir on the ToolContext. Default actor is
 * `mcp:test-client`; pass another actor to test cross-actor gating.
 *
 * `activateProForMcp(tc)` flips the workspace license to a signed
 * Pro key — needed for the Pro-gated audit-N4 hide-on-archive path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { TagsRepository } from '../../src/core/tags/repository.js';
import { RevisionsRepository } from '../../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../../src/core/notes/comments-repository.js';
import { FtsIndex } from '../../src/core/search/fts.js';
import { VecIndex } from '../../src/core/search/vec.js';
import { HybridSearch } from '../../src/core/search/hybrid.js';
import { Indexer } from '../../src/core/search/indexer.js';
import { NoopEmbeddings } from '../../src/core/embeddings/noop.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';
import type { ToolContext } from '../../src/server/tools/types.js';


export function activateProForMcp(_tc: ToolContext): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

export interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
}

export function setup(actor = 'mcp:test-client'): Ctx {
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
  return {
    handle,
    tc: {
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
      configDir: mkdtempSync(join(tmpdir(), 'morion-mcp-tools-')),
    },
  };
}
