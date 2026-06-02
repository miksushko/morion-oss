import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditRecentTool,
  notesCreateTool,
  notesGetAttachmentTool,
  notesListAttachmentsTool,
} from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Note } from '../src/core/notes/types.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';
import { isRawContentResult } from '../src/server/tools/types.js';

describe('MCP tools — attachments', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  // Direction P — attachment MCP tools.

  // Same 1×1 PNG used in tests/attachments.test.ts, copied inline so we
  // don't cross test-file boundaries.
  const TINY_PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  function seedAttachment(tc: Ctx['tc'], noteId: string) {
    const id = '01KPDAAV5BMF8BKAE8RA9HQH09';
    const path = join(tc.configDir, 'attachments', `${id}.png`);
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(tc.configDir, 'attachments'), { recursive: true });
    writeFileSync(path, TINY_PNG);
    // Insert directly via repo (skips the HTTP sniff path) — we're
    // testing the MCP tool layer, not the upload pipeline which has
    // its own integration tests.
    tc.attachments.create({
      noteId,
      filePath: path,
      mimeType: 'image/png',
      sizeBytes: TINY_PNG.byteLength,
      sha256: 'deadbeef',
      width: 1,
      height: 1,
    });
    return { id: tc.attachments.listByNoteId(noteId)[0].id, path };
  }

  describe('notes_list_attachments', () => {
    it('returns metadata for every attachment on a note (no bytes)', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# with attach' },
        ctx.tc,
      )) as Note;
      const { id: attId } = seedAttachment(ctx.tc, note.id);

      const res = (await notesListAttachmentsTool.handler(
        { noteId: note.id },
        ctx.tc,
      )) as {
        noteId: string;
        attachments: Array<{
          id: string;
          mimeType: string;
          sizeBytes: number;
          width: number | null;
          height: number | null;
          url: string;
        }>;
      };
      expect(res.noteId).toBe(note.id);
      expect(res.attachments).toHaveLength(1);
      const [a] = res.attachments;
      expect(a.id).toBe(attId);
      expect(a.mimeType).toBe('image/png');
      expect(a.sizeBytes).toBe(TINY_PNG.byteLength);
      expect(a.width).toBe(1);
      expect(a.height).toBe(1);
      expect(a.url).toBe(`morion://attachment/${attId}`);
      // Sanity: no `data` or `dataBase64` keys — list is metadata only.
      expect(Object.keys(a)).not.toContain('data');
      expect(Object.keys(a)).not.toContain('dataBase64');
    });

    it('returns an empty attachments array for a note with none', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# no images' },
        ctx.tc,
      )) as Note;
      const res = (await notesListAttachmentsTool.handler(
        { noteId: note.id },
        ctx.tc,
      )) as { attachments: unknown[] };
      expect(res.attachments).toHaveLength(0);
    });

    it('returns note_not_found for an unknown id', async () => {
      const res = await notesListAttachmentsTool.handler(
        { noteId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'note_not_found' });
    });
  });

  describe('notes_get_attachment', () => {
    it('returns MCP ImageContent (not base64-in-text) for a valid id', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# image note' },
        ctx.tc,
      )) as Note;
      const { id } = seedAttachment(ctx.tc, note.id);

      const res = await notesGetAttachmentTool.handler({ id }, ctx.tc);
      // This is the key property we test: the tool returns the raw-
      // content sentinel so the mcp.ts dispatcher surfaces an
      // ImageContent item. Claude's vision tokenizer handles image
      // content at ~1-5k tokens; a naive JSON envelope with a base64
      // string would be ~250k tokens/MB.
      expect(isRawContentResult(res)).toBe(true);
      const raw = res as { _mcpContent: Array<{ type: string; data: string; mimeType: string }> };
      expect(raw._mcpContent).toHaveLength(1);
      expect(raw._mcpContent[0].type).toBe('image');
      expect(raw._mcpContent[0].mimeType).toBe('image/png');
      const decoded = Buffer.from(raw._mcpContent[0].data, 'base64');
      expect(decoded.equals(TINY_PNG)).toBe(true);
    });

    it('records an audit read against the owning note', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# image note' },
        ctx.tc,
      )) as Note;
      const { id } = seedAttachment(ctx.tc, note.id);
      await notesGetAttachmentTool.handler({ id }, ctx.tc);

      const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
      const read = rows.find(
        (r) => r.action === 'read' && r.noteId === note.id && r.actor === 'mcp:test-client',
      );
      expect(read).toBeDefined();
    });

    it('rejects a malformed id with invalid_id', async () => {
      const res = await notesGetAttachmentTool.handler(
        { id: '../../etc/passwd' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'invalid_id' });
    });

    it('returns not_found for a well-shaped but unknown id', async () => {
      const res = await notesGetAttachmentTool.handler(
        { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'not_found' });
    });
  });
});
