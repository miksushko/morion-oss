import type Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import { openDb } from '../src/core/db/client.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';

function setup(): { db: Database.Database; folderId: string } {
  const handle = openDb({ path: ':memory:' });
  const folderId = '01ABCDEFGHJKMNPQRSTVWXYZ00';
  handle.db
    .prepare(
      `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
    )
    .run(folderId, 'F', Date.now());
  return { db: handle.db, folderId };
}

const SIMPLE_DEF: WorkflowDefinition = LEGACY_LINEAR_AUTOCODE_DEFINITION;

describe('WorkflowsRepository', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('create round-trips name + definition + isDefault', () => {
    const repo = new WorkflowsRepository(ctx.db);
    const created = repo.create({
      folderId: ctx.folderId,
      name: 'My workflow',
      definition: SIMPLE_DEF,
      isDefault: true,
    });
    expect(created.name).toBe('My workflow');
    expect(created.isDefault).toBe(true);
    expect(created.definition.stages.length).toBe(SIMPLE_DEF.stages.length);
    expect(created.definition.stages[0]!.id).toBe(SIMPLE_DEF.stages[0]!.id);

    const fetched = repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('My workflow');
  });

  it('listForFolder returns rows ordered default-first then name ASC', () => {
    const repo = new WorkflowsRepository(ctx.db);
    repo.create({ folderId: ctx.folderId, name: 'B', definition: SIMPLE_DEF });
    repo.create({
      folderId: ctx.folderId,
      name: 'A',
      definition: SIMPLE_DEF,
      isDefault: true,
    });
    repo.create({ folderId: ctx.folderId, name: 'C', definition: SIMPLE_DEF });
    const list = repo.listForFolder(ctx.folderId);
    expect(list.map((w) => w.name)).toEqual(['A', 'B', 'C']);
    expect(list[0]!.isDefault).toBe(true);
  });

  it('isDefault is exclusive within a folder — setting a new default clears the old one', () => {
    const repo = new WorkflowsRepository(ctx.db);
    const first = repo.create({
      folderId: ctx.folderId,
      name: 'First',
      definition: SIMPLE_DEF,
      isDefault: true,
    });
    const second = repo.create({
      folderId: ctx.folderId,
      name: 'Second',
      definition: SIMPLE_DEF,
      isDefault: true,
    });
    const refetchedFirst = repo.getById(first.id);
    const refetchedSecond = repo.getById(second.id);
    expect(refetchedFirst!.isDefault).toBe(false);
    expect(refetchedSecond!.isDefault).toBe(true);
  });

  it('update patches name + definition + isDefault', () => {
    const repo = new WorkflowsRepository(ctx.db);
    const created = repo.create({
      folderId: ctx.folderId,
      name: 'Original',
      definition: SIMPLE_DEF,
    });
    const updated = repo.update(created.id, {
      name: 'Renamed',
      isDefault: true,
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed');
    expect(updated!.isDefault).toBe(true);
  });

  it('update returns null on unknown id', () => {
    const repo = new WorkflowsRepository(ctx.db);
    expect(repo.update('does-not-exist', { name: 'X' })).toBeNull();
  });

  it('delete returns true on hit, false on miss', () => {
    const repo = new WorkflowsRepository(ctx.db);
    const created = repo.create({
      folderId: ctx.folderId,
      name: 'X',
      definition: SIMPLE_DEF,
    });
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.delete(created.id)).toBe(false);
    expect(repo.getById(created.id)).toBeNull();
  });

  it('getByIdForFolder returns row only when folder owns it (Codex P1b round 3)', () => {
    const repo = new WorkflowsRepository(ctx.db);
    // Add a second folder + a workflow row owned by it.
    const otherFolderId = '01ABCDEFGHJKMNPQRSTVWXYZ99';
    ctx.db
      .prepare(
        `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
      )
      .run(otherFolderId, 'Other', Date.now());
    const owned = repo.create({
      folderId: ctx.folderId,
      name: 'A',
      definition: SIMPLE_DEF,
    });
    const foreign = repo.create({
      folderId: otherFolderId,
      name: 'B',
      definition: SIMPLE_DEF,
    });

    // Owner sees its own row.
    expect(repo.getByIdForFolder(owned.id, ctx.folderId)?.id).toBe(owned.id);
    // Owner cannot fetch the foreign folder's row by id.
    expect(repo.getByIdForFolder(foreign.id, ctx.folderId)).toBeNull();
    // Same id from the other folder's perspective resolves.
    expect(repo.getByIdForFolder(foreign.id, otherFolderId)?.id).toBe(
      foreign.id,
    );
  });

  it('create rejects non-linear definitions outside the v2 draft set (linear-only L2 constraint)', () => {
    const repo = new WorkflowsRepository(ctx.db);
    // `branch` is still L4-only and intentionally OUT of V2_STAGE_KINDS
    // (the editor has no UX surface for it yet) — repo.create routes it
    // through parseLinearWorkflow and parseLinearWorkflow rejects with
    // a clean L3/L4 error. `human_gate` moved INTO V2_STAGE_KINDS in
    // 2026-05-11 so v2 templates can embed "Human in the loop" stages
    // matching the spec — those save via parseDraftWorkflow and fail
    // only at dispatch.
    const bad = {
      schemaVersion: 1,
      name: 'Bad',
      stages: [
        {
          id: 'b1',
          kind: 'branch',
          combinator: 'all',
          conditions: [{ field: 'x', op: 'eq', value: 'y' }],
        },
      ],
      edges: [],
    } as unknown as WorkflowDefinition;
    expect(() =>
      repo.create({
        folderId: ctx.folderId,
        name: 'Bad',
        definition: bad,
      }),
    ).toThrow();
  });

  it('create accepts a v2 draft with a human_gate stage (Editor Model v2 spec)', () => {
    const repo = new WorkflowsRepository(ctx.db);
    // v2 templates may embed a Human In The Loop stage per the
    // Editor Model spec (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1).
    // Saves via parseDraftWorkflow; dispatch is gated on L3 runtime.
    const def = {
      schemaVersion: 1,
      name: 'V2 HITL',
      description: '',
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          instruction: '',
          branches: ['accept', 'reject'],
          postComment: true,
          isStart: true,
          allowedTools: null,
        },
        {
          id: 'human',
          kind: 'human_gate',
          prompt: 'Reply in chat — Mo reads it on its next turn.',
        },
        { id: 'reject_terminal', kind: 'reject_sink', commentTemplate: '' },
        {
          id: 'complete_terminal',
          kind: 'complete_sink',
          commentTemplate: '',
        },
      ],
      edges: [
        { from: 'mo_start', to: 'human', on: 'accept' },
        { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
        // Single outbound from human_gate — goes to complete in
        // this test fixture so the v2 reachability check passes;
        // real templates route back to a downstream Mo, which
        // then walks the chain to complete on its next turn.
        { from: 'human', to: 'complete_terminal', on: 'reply' },
      ],
    } as unknown as WorkflowDefinition;
    expect(() =>
      repo.create({
        folderId: ctx.folderId,
        name: 'V2 HITL',
        definition: def,
      }),
    ).not.toThrow();
  });

  it('listSummariesForFolder marks rows containing v2 stage kinds as isDraft (Codex P1 round 4, 2026-05-11)', () => {
    const repo = new WorkflowsRepository(ctx.db);
    // Legacy linear cli_agent row — runnable, NOT draft.
    repo.create({
      folderId: ctx.folderId,
      name: 'Linear runnable',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    // v2 draft row containing mo_stage / sinks — preview only.
    const v2Def = {
      schemaVersion: 1,
      name: 'V2 draft',
      description: '',
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          instruction: '',
          branches: ['accept', 'reject'],
          postComment: true,
          isStart: true,
          allowedTools: null,
        },
        { id: 'reject_terminal', kind: 'reject_sink', commentTemplate: '' },
        {
          id: 'complete_terminal',
          kind: 'complete_sink',
          commentTemplate: '',
        },
      ],
      edges: [
        { from: 'mo_start', to: 'complete_terminal', on: 'accept' },
        { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
      ],
    } as unknown as WorkflowDefinition;
    repo.create({
      folderId: ctx.folderId,
      name: 'V2 draft',
      definition: v2Def,
    });
    const summaries = repo.listSummariesForFolder(ctx.folderId);
    const linear = summaries.find((s) => s.name === 'Linear runnable');
    const draft = summaries.find((s) => s.name === 'V2 draft');
    expect(linear?.isDraft).toBe(false);
    expect(draft?.isDraft).toBe(true);
  });
});
