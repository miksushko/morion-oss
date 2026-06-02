/**
 * Regression: Mo bug ticket `01KQ1R97C0GK6KPQF03AFCZ42B` —
 * "tags_delete for every id returned by tags_list, then tags_list
 * still shows tags."
 *
 * The hypothesis in the ticket is server-side: caching, stale index,
 * or partial cascade. This test pins the SERVER contract — given a
 * realistic-size workspace (150 tags, some with note links), calling
 * `tags_delete` for every id should empty the table. If this test
 * passes, the divergence the user observed lives in the UI/WS layer
 * (stale React state, WS frame loss on reconnect), not in the
 * tags repository or its tools.
 *
 * Also pins: the slim-projection / truncation envelope path used by
 * Mo's chat dispatcher returns the SAME row count as the raw
 * repository — so even at 150 tags with a 12 KB chat budget, Mo
 * receives an envelope where `total === 150` and acting on it should
 * not phantom-delete or skip rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { tagsListTool, tagsDeleteTool } from '../src/server/tools/index.js';
import {
  dispatchMoTool,
  serializeMoToolResultForChat,
} from '../src/core/concierge/mo-tools.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
}

function setup(actor = 'morion-concierge'): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const tags = new TagsRepository(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  return {
    handle,
    tc: {
      db: handle.db,
      tags,
      notes,
      audit,
      actor,
    } as unknown as ToolContext,
  };
}

describe('Tag bulk-delete regression (01KQ1R97C0GK6KPQF03AFCZ42B)', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('tags_list after tags_delete-for-all returns []', async () => {
    // 150 tags — same scale as the user's prod workspace.
    for (let i = 0; i < 150; i++) {
      ctx.tc.tags.upsertByName(`bulk-${i.toString().padStart(3, '0')}`);
    }
    const before = await tagsListTool.handler({}, ctx.tc);
    expect(before).toHaveLength(150);

    for (const tag of before) {
      const result = await tagsDeleteTool.handler({ id: tag.id }, ctx.tc);
      expect(result).toEqual({ ok: true });
    }

    const after = await tagsListTool.handler({}, ctx.tc);
    expect(after).toEqual([]);
  });

  it('cascades note_tags when the tag had links', async () => {
    const tagA = ctx.tc.tags.upsertByName('linked-a');
    const tagB = ctx.tc.tags.upsertByName('linked-b');
    const note = ctx.tc.notes.create(
      { body: '# linked', source: 'user', tags: [tagA.name, tagB.name] },
      'user',
    );
    expect(note.tags.sort()).toEqual(['linked-a', 'linked-b']);

    const ok = await tagsDeleteTool.handler({ id: tagA.id }, ctx.tc);
    expect(ok).toEqual({ ok: true });

    const remaining = await tagsListTool.handler({}, ctx.tc);
    expect(remaining.map((t) => t.name)).toEqual(['linked-b']);

    // Note still exists; its tag list lost the deleted entry.
    const reload = ctx.tc.notes.getById(note.id);
    expect(reload?.tags).toEqual(['linked-b']);
  });

  it('Mo chat dispatch returns total=150 even when the chat budget truncates', async () => {
    for (let i = 0; i < 150; i++) {
      ctx.tc.tags.upsertByName(`chat-${i.toString().padStart(3, '0')}`);
    }

    const env = await dispatchMoTool(
      [tagsListTool],
      { name: 'tags_list', argumentsJson: '{}' },
      ctx.tc,
    );
    expect(env.ok).toBe(true);
    // serialize-with-budget: even if the JSON exceeds 12_000 bytes the
    // helper must NEVER slice mid-array. It either fits as-is or
    // returns a structured truncation envelope. In both cases the
    // returned `total` count must reflect every row in the DB so Mo
    // can act on accurate counts (the user's "0 vs 50" symptom).
    const { json, total } = serializeMoToolResultForChat('tags_list', env);
    expect(() => JSON.parse(json)).not.toThrow();
    // Tags-as-tools is a top-level array shape — when it fits, total
    // reflects array length; when it doesn't fit (rare for tags), the
    // helper exposes total via the truncation envelope.
    if (total !== null) {
      expect(total).toBe(150);
    } else {
      const parsed = JSON.parse(json) as { ok: boolean; data: unknown };
      expect(Array.isArray(parsed.data) ? parsed.data.length : null).toBe(150);
    }
  });

  it('repeated bulk-delete does not leave orphan rows in note_tags', async () => {
    // Real-world: user creates 50, deletes, creates more, deletes — the
    // "50+ tags still visible" symptom could come from orphan note_tags
    // pointing at deleted tag rows. Pin that this can't happen.
    const handle = ctx.handle;
    for (let pass = 0; pass < 3; pass++) {
      const created = [];
      for (let i = 0; i < 20; i++) {
        const t = ctx.tc.tags.upsertByName(`p${pass}-${i}`);
        created.push(t);
      }
      // Attach a note to each so note_tags has rows.
      const noteIds = [];
      for (const t of created) {
        const n = ctx.tc.notes.create(
          { body: `pass ${pass} ${t.name}`, source: 'user', tags: [t.name] },
          'user',
        );
        noteIds.push(n.id);
      }
      for (const t of created) {
        await tagsDeleteTool.handler({ id: t.id }, ctx.tc);
      }
      const orphans = handle.db
        .prepare(
          `SELECT COUNT(*) as n FROM note_tags WHERE tag_id NOT IN (SELECT id FROM tags)`,
        )
        .get() as { n: number };
      expect(orphans.n).toBe(0);
    }
    expect(await tagsListTool.handler({}, ctx.tc)).toEqual([]);
  });
});
