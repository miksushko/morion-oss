import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { APP_VERSION } from '../src/core/version.js';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression for audit finding R4 (2026-04-16). `package.json` is the
 * single source of truth for the app version; every other surface MUST
 * read through `APP_VERSION`. These tests pin two invariants:
 *
 *   1. `APP_VERSION` is an exact string match for `package.json`.version.
 *   2. `GET /api/health` returns that same string (not the old hardcoded
 *      `0.1.0-alpha.0` that drifted all the way through v0.99.3).
 *
 * The CLI `--version` output is wired the same way (`commander
 * .version(APP_VERSION)`), tested indirectly by the binary-smoke suite.
 */

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

describe('APP_VERSION — single source of truth', () => {
  it('matches package.json.version exactly', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('looks like a semver-ish string, not the ancient 0.1.0-alpha.0 placeholder', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_VERSION).not.toBe('0.1.0-alpha.0');
  });
});

describe('GET /api/health version field', () => {
  let handle: DbHandle;

  function buildApp() {
    handle = openDb({ path: ':memory:' });
    const audit = new AuditLogger(handle.db);
    const notes = new NotesRepository(handle.db, audit);
    const folders = new FoldersRepository(handle.db);
    const tags = new TagsRepository(handle.db);
    const revisions = new RevisionsRepository(handle.db);
    const fts = new FtsIndex(handle.db);
    const vec = new VecIndex(handle.db, handle.hasVec);
    const embeddings = new NoopEmbeddings();
    const search = new HybridSearch(handle.db, fts, vec, embeddings);
    const indexer = new Indexer(vec, embeddings);
    const settings = new SettingsRepository(handle.db);
    const attachments = new AttachmentsRepository(handle.db);
    const configDir = mkdtempSync(join(tmpdir(), 'morion-version-test-'));
    return buildHttpApp({
      db: handle.db,
      notes,
      folders,
      tags,
      revisions,
      attachments,
      search,
      indexer,
      audit,
      settings,
      configDir,
    });
  }

  it('returns the current package version', async () => {
    const app = buildApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(pkg.version);
  });
});
