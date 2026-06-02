import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditRecentTool,
  notesCreateTool,
  notesDeleteTool,
  notesUpdateTool,
} from '../src/server/tools/index.js';
import { type Ctx, activateProForMcp, setup } from './mcp-tools/helpers.js';
import type { Note } from '../src/core/notes/types.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';

describe('MCP tools — audit', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('audit_recent', () => {
    it('returns rows in DESC order with hydrated note titles', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# tracked\n\nv1' },
        ctx.tc,
      )) as Note;
      await notesUpdateTool.handler({ id: note.id, body: '# tracked\n\nv2' }, ctx.tc);

      const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // Newest first.
      expect(rows[0].action).toBe('update');
      expect(rows[0].noteId).toBe(note.id);
      expect(rows[0].noteTitle).toBe('tracked');
      // Older create row is also there.
      expect(rows.some((r) => r.action === 'create' && r.noteId === note.id)).toBe(true);
    });

    it('filters by actor', async () => {
      // Run a tool with the default 'mcp:test-client' context, then a second
      // context impersonating a different actor.
      await notesCreateTool.handler({ body: 'a' }, ctx.tc);
      const otherActorCtx: ToolContext = { ...ctx.tc, actor: 'mcp:other-client' };
      await notesCreateTool.handler({ body: 'b' }, otherActorCtx);

      const filtered = (await auditRecentTool.handler(
        { actor: 'mcp:other-client' },
        ctx.tc,
      )) as AuditRecentEntry[];
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((r) => r.actor === 'mcp:other-client')).toBe(true);
    });

    it('honours the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await notesCreateTool.handler({ body: `n${i}` }, ctx.tc);
      }
      const rows = (await auditRecentTool.handler({ limit: 3 }, ctx.tc)) as AuditRecentEntry[];
      expect(rows).toHaveLength(3);
    });

    it('filters out rows for hidden notes on Pro (audit N4)', async () => {
      // Regression for 2026-04-16 audit finding N4. An LLM client that
      // has no read access to a folder must not see audit entries about
      // notes inside it — otherwise existence of the folder + activity
      // on its notes leaks through audit_recent.
      const hidden = ctx.tc.folders.create('Hidden');
      const open = ctx.tc.folders.create('Open');
      const hiddenNote = (await notesCreateTool.handler(
        { body: '# secret', folderId: hidden.id },
        ctx.tc,
      )) as Note;
      const openNote = (await notesCreateTool.handler(
        { body: '# public', folderId: open.id },
        ctx.tc,
      )) as Note;
      ctx.tc.folders.setMcpPermissions(hidden.id, {
        visible: false,
        create: true,
        update: true,
        delete: true,
      });

      activateProForMcp(ctx.tc);

      const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
      const ids = rows.map((r) => r.noteId);
      expect(ids).not.toContain(hiddenNote.id);
      expect(ids).toContain(openNote.id);
    });

    it('still surfaces titles for soft-deleted notes', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# gone but not forgotten' },
        ctx.tc,
      )) as Note;
      await notesDeleteTool.handler({ id: note.id }, ctx.tc);

      const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
      const deleteRow = rows.find((r) => r.action === 'delete' && r.noteId === note.id);
      expect(deleteRow).toBeDefined();
      expect(deleteRow!.noteTitle).toBe('gone but not forgotten');
    });
  });
});
