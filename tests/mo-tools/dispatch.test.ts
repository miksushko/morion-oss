import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatchMoTool } from '../../src/core/concierge/mo-tools.js';
import type { ToolDef } from '../../src/server/tools/types.js';
import { mcpRawContent } from '../../src/server/tools/types.js';
import { stubCtx } from '../helpers/mo-tools-setup.js';

/**
 * `dispatchMoTool` envelope shapes — unknown-tool / invalid-JSON /
 * zod-validation-failure / handler-threw / happy-path / empty-args /
 * `_mcpContent` sentinel collapse. Pinned by the per-source-leaf
 * split `src/core/concierge/mo-tools/dispatch.ts`.
 */
describe('dispatchMoTool — envelope shapes', () => {
  const happyTool: ToolDef<{ msg: z.ZodString }> = {
    name: 'echo',
    description: 'echo',
    category: 'read',
    inputShape: { msg: z.string() },
    handler: async (input) => ({ echoed: input.msg }),
  };

  it('returns unknown_tool envelope for missing tool name', async () => {
    const result = await dispatchMoTool(
      [happyTool],
      { name: 'nonexistent', argumentsJson: '{}' },
      stubCtx(),
    );
    expect(result).toEqual({ error: 'unknown_tool', name: 'nonexistent' });
  });

  it('returns invalid_json_arguments envelope for malformed JSON', async () => {
    const result = await dispatchMoTool(
      [happyTool],
      { name: 'echo', argumentsJson: '{not valid' },
      stubCtx(),
    );
    expect(result).toEqual({ error: 'invalid_json_arguments' });
  });

  it('returns validation envelope for zod-schema failure', async () => {
    const result = await dispatchMoTool(
      [happyTool],
      { name: 'echo', argumentsJson: '{"msg": 42}' },
      stubCtx(),
    );
    expect(result).toMatchObject({ error: 'validation' });
    expect((result as { issues: unknown[] }).issues).toBeInstanceOf(Array);
  });

  it('returns handler_threw envelope when handler rejects', async () => {
    const throwingTool: ToolDef<Record<string, z.ZodString>> = {
      name: 'boom',
      description: 'boom',
      category: 'read',
      inputShape: {},
      handler: async () => {
        throw new Error('kaboom');
      },
    };
    const result = await dispatchMoTool(
      [throwingTool],
      { name: 'boom', argumentsJson: '{}' },
      stubCtx(),
    );
    expect(result).toMatchObject({
      error: 'handler_threw',
      message: expect.stringContaining('kaboom'),
    });
  });

  it('caps handler error message at 300 chars', async () => {
    const throwingTool: ToolDef<Record<string, z.ZodString>> = {
      name: 'boom',
      description: 'boom',
      category: 'read',
      inputShape: {},
      handler: async () => {
        throw new Error('x'.repeat(500));
      },
    };
    const result = await dispatchMoTool(
      [throwingTool],
      { name: 'boom', argumentsJson: '{}' },
      stubCtx(),
    );
    const msg = (result as { message: string }).message;
    expect(msg.length).toBeLessThanOrEqual(300);
  });

  it('returns happy-path {ok, data} envelope with handler result', async () => {
    const result = await dispatchMoTool(
      [happyTool],
      { name: 'echo', argumentsJson: '{"msg": "hi"}' },
      stubCtx(),
    );
    expect(result).toEqual({ ok: true, data: { echoed: 'hi' } });
  });

  it('treats empty argumentsJson as empty object (handler still gets zod-validated)', async () => {
    // Tools with no required args should handle empty arguments cleanly.
    const noArgsTool: ToolDef<Record<string, z.ZodString>> = {
      name: 'no-args',
      description: 'no args',
      category: 'read',
      inputShape: {},
      handler: async () => ({ ran: true }),
    };
    const result = await dispatchMoTool(
      [noArgsTool],
      { name: 'no-args', argumentsJson: '' },
      stubCtx(),
    );
    expect(result).toEqual({ ok: true, data: { ran: true } });
  });

  it('collapses _mcpContent sentinel to a legible text marker (no bytes leak to LLM)', async () => {
    // Tools returning mcpRawContent (e.g. notes_get_attachment) must
    // not feed the raw image bytes back into the chat transcript —
    // that would burn through context and crash some providers. The
    // dispatcher flattens them to a short "binary content" marker.
    const imageTool: ToolDef<Record<string, z.ZodString>> = {
      name: 'image-like',
      description: 'returns image',
      category: 'read',
      inputShape: {},
      handler: async () =>
        mcpRawContent([
          {
            type: 'image',
            data: 'aGVsbG8=', // base64 of "hello"
            mimeType: 'image/png',
          },
        ]),
    };
    const result = await dispatchMoTool(
      [imageTool],
      { name: 'image-like', argumentsJson: '{}' },
      stubCtx(),
    );
    expect(result).toHaveProperty('ok', true);
    expect(result).toHaveProperty('note');
    expect((result as { note: string }).note).toContain('binary');
    expect(JSON.stringify(result)).not.toContain('aGVsbG8=');
  });
});
