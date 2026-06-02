import { beforeEach, describe, expect, it } from 'vitest';
import {
  notesCreateTool,
  notesGetTool,
  tagsCreateTool,
  tagsDeleteTool,
  tagsListTool,
  tagsUpdateTool,
} from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import type { Note, Tag } from '../src/core/notes/types.js';

describe('MCP tools — tags', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('tags_list', () => {
    it('returns all tags alphabetically with note counts', async () => {
      await notesCreateTool.handler({ body: 'n', tags: ['zeta', 'alpha'] }, ctx.tc);

      const result = (await tagsListTool.handler({}, ctx.tc)) as Tag[];
      expect(result.map((t) => t.name)).toEqual(['alpha', 'zeta']);
      expect(result.every((t) => t.noteCount === 1)).toBe(true);
    });
  });

  describe('tags_create', () => {
    it('creates a tag with name and color', async () => {
      const tag = (await tagsCreateTool.handler(
        { name: 'priority', color: '#ff5733' },
        ctx.tc,
      )) as Tag;
      expect(tag.name).toBe('priority');
      expect(tag.color).toBe('#ff5733');
      expect(tag.noteCount).toBe(0);
    });

    it('throws on duplicate name', async () => {
      await tagsCreateTool.handler({ name: 'dup' }, ctx.tc);
      await expect(tagsCreateTool.handler({ name: 'dup' }, ctx.tc)).rejects.toThrow();
    });
  });

  describe('tags_update', () => {
    it('renames a tag and clears its color', async () => {
      const created = (await tagsCreateTool.handler(
        { name: 'old', color: '#000000' },
        ctx.tc,
      )) as Tag;

      const renamed = (await tagsUpdateTool.handler(
        { id: created.id, name: 'new' },
        ctx.tc,
      )) as Tag;
      expect(renamed.name).toBe('new');
      expect(renamed.color).toBe('#000000');

      const cleared = (await tagsUpdateTool.handler(
        { id: created.id, color: null },
        ctx.tc,
      )) as Tag;
      expect(cleared.color).toBeNull();
    });

    it('returns null when the id does not exist', async () => {
      const result = await tagsUpdateTool.handler(
        { id: '01HXNOTREALID', name: 'x' },
        ctx.tc,
      );
      expect(result).toBeNull();
    });
  });

  describe('tags_delete', () => {
    it('deletes a tag and cascades note_tags, leaving notes intact', async () => {
      const note = (await notesCreateTool.handler(
        { body: 'A', tags: ['keep', 'doomed'] },
        ctx.tc,
      )) as Note;
      const doomed = ctx.tc.tags.findByName('doomed');
      expect(doomed).not.toBeNull();

      const result = (await tagsDeleteTool.handler({ id: doomed!.id }, ctx.tc)) as { ok: boolean };
      expect(result.ok).toBe(true);

      const stillThere = (await notesGetTool.handler({ id: note.id }, ctx.tc)) as Note | null;
      expect(stillThere?.tags).toEqual(['keep']);
    });

    it('returns ok=false when the tag does not exist', async () => {
      const result = (await tagsDeleteTool.handler({ id: '01HXNOTREALID' }, ctx.tc)) as {
        ok: boolean;
      };
      expect(result.ok).toBe(false);
    });
  });
});
