import { describe, it, expect, beforeEach } from 'vitest';
import { gatherContext } from '../../src/core/concierge/index.js';
import {
  setup,
  GatherStubProvider,
  defaultResponder,
  type Ctx,
} from '../helpers/mo-gather-setup.js';

// Bug 01KR5FBYS9QRM60BMX54DR1XZR — Wave 2 index drift between
// bodyTargetIds (Set) and bodyBatch.results (skipped entries when
// notes.getById returns null). Used to crash with "Cannot read
// properties of undefined (reading 'ok')".

describe('gatherContext — Wave 2 robustness (regression 01KR5FBYS9QRM60BMX54DR1XZR)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('does not throw when cluster-analyst returns drillIntoNoteIds pointing at non-existent notes', async () => {
    const folder = ctx.folders.create('Drift folder');
    const task = ctx.notes.create(
      {
        body: '# Task body that survives the gate',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const realSibling = ctx.notes.create(
      {
        body: '# A real sibling',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.clusters.upsert({
      noteId: task.id,
      clusterId: 'drift',
      source: 'tier1',
      confidence: 1,
    });
    ctx.clusters.upsert({
      noteId: realSibling.id,
      clusterId: 'drift',
      source: 'tier1',
      confidence: 0.9,
    });

    // Cluster analyst names a non-existent id BEFORE the real sibling.
    // That puts a "ghost" in bodyTargetIds — notes.getById returns null
    // → bodyScopes loses an entry → results shorter than bodyTargetIds
    // → loop reads past results.length → undefined.ok crash (pre-fix).
    const provider = new GatherStubProvider((req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('task-cluster-analyst')) {
        return {
          content: JSON.stringify({
            drillIntoNoteIds: ['01GHOST_NEVER_EXISTED', realSibling.id],
            why: 'Two candidates — one ghost id, one real sibling.',
          }),
        };
      }
      return defaultResponder(req);
    });

    // Should NOT throw. Should produce a packet with the real sibling
    // surfaced; the ghost is silently dropped at the body-extract step.
    const packet = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    expect(packet.synthesizedMarkdown.length).toBeGreaterThan(0);
  });

  it('tolerates ALL drilled ids being non-existent (every scope skipped)', async () => {
    const folder = ctx.folders.create('All-ghost folder');
    const task = ctx.notes.create(
      {
        body: '# Task',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.clusters.upsert({
      noteId: task.id,
      clusterId: 'all-ghosts',
      source: 'tier1',
      confidence: 1,
    });
    // Need a second note in the cluster so clusterScopes is non-empty
    // (Wave 1 builds scopes only when noteIds.length > 0 per
    // gather.ts:459).
    const sib = ctx.notes.create(
      { body: 'sib', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({
      noteId: sib.id,
      clusterId: 'all-ghosts',
      source: 'tier1',
      confidence: 0.9,
    });

    const provider = new GatherStubProvider((req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('task-cluster-analyst')) {
        return {
          content: JSON.stringify({
            drillIntoNoteIds: ['01GHOST_A', '01GHOST_B', '01GHOST_C'],
            why: 'All ghosts.',
          }),
        };
      }
      return defaultResponder(req);
    });

    const packet = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    expect(packet.synthesizedMarkdown.length).toBeGreaterThan(0);
  });
});
