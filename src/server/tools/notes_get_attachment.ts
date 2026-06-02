import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, mcpRawContent } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { attachmentIdSchema } from '../../core/attachments/types.js';

/**
 * Return the bytes of a single attachment as MCP `ImageContent`.
 *
 * The important part is HOW this is packaged: we return
 * `{ type: 'image', data: base64, mimeType }` — Claude handles this
 * as a vision input, spending ~1-5k tokens per image total, regardless
 * of file size. The naive alternative (`{ dataBase64: "..." }` inside
 * a text JSON envelope) would charge Claude the raw base64 string
 * length — ~250k tokens per MB, ~2.5M tokens for a 10 MB image,
 * blowing the context window for nothing.
 *
 * Permission gate matches `notes_get`: read permission on the owning
 * note. If the user has marked a folder as hidden-from-AI, attachments
 * inside its notes stay hidden.
 *
 * Size cap: 10 MB (same as upload). Claude downscales internally for
 * its vision tokenizer; we don't need a smaller ceiling here.
 */
const MAX_BYTES_IN_MCP = 10 * 1024 * 1024;

export const notesGetAttachmentTool = defineTool({
  name: 'notes_get_attachment',
  description:
    'Fetch the bytes of a single attachment as an image. Returns MCP ImageContent so the bytes count as a vision input (~1-5k tokens) rather than base64 text (~250k tokens/MB). Use notes_list_attachments first to pick the id.',
  category: 'read',
  inputShape: {
    id: z
      .string()
      .describe(
        'The ulid of the attachment to fetch. Get this from notes_list_attachments, or from a morion://attachment/<id> URL in a note body.',
      ),
  },
  async handler(input, ctx) {
    const parsed = attachmentIdSchema.safeParse(input.id);
    if (!parsed.success) return { error: 'invalid_id' };
    const row = ctx.attachments.getById(parsed.data);
    if (!row) return { error: 'not_found' };

    // Gate via the owning note's read permission. Matches the HTTP
    // GET /api/attachments/:id handler.
    if (!canPerform('read', ctx, { kind: 'note', noteId: row.noteId })) {
      return ACCESS_DENIED;
    }

    if (row.sizeBytes > MAX_BYTES_IN_MCP) {
      return {
        error: 'attachment_too_large',
        sizeBytes: row.sizeBytes,
        limit: MAX_BYTES_IN_MCP,
      };
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(row.filePath);
    } catch (err) {
      // File vanished from disk (manual rm, aborted migration). DB
      // row exists but no bytes to return.
      return {
        error: 'file_missing',
        detail: (err as Error).message,
      };
    }

    // Audit the read against the owning note so "who fetched this
    // image when" is discoverable via audit_recent.
    ctx.audit.record({
      noteId: row.noteId,
      action: 'read',
      actor: ctx.actor,
    });

    return mcpRawContent([
      {
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: row.mimeType,
      },
    ]);
  },
});
