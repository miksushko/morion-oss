import { z } from 'zod';
import type { ToolContext, ToolDef } from '../../../server/tools/types.js';
import type { MoToolInvocation } from './schema.js';

/**
 * Dispatch a single tool call emitted by the chat LLM against the
 * canonical MCP handler. Parses + zod-validates the arguments, then
 * awaits the handler and returns its result (serialised to a string
 * suitable for feeding back into the provider as a `role='tool'`
 * message).
 *
 * Permission denials surface through `{ error }` envelopes the same
 * way they do over stdio MCP — the chat LLM sees the denial and can
 * decide to retry a different folder or tell the user why.
 *
 * List-style returns (`notes_list`, `notes_recent`, `tasks_list`) are
 * slim-projected here — full markdown bodies stay out of the chat
 * transcript. The MCP stdio surface is unchanged; this projection is
 * specific to the Mo chat path. See `serializeMoToolResultForChat`
 * for the size-budget step that runs at the call site.
 */
export async function dispatchMoTool(
  tools: ReadonlyArray<ToolDef<z.ZodRawShape>>,
  call: MoToolInvocation,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const def = tools.find((t) => t.name === call.name);
  if (!def) return { error: 'unknown_tool', name: call.name };
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(call.argumentsJson || '{}');
  } catch {
    return { error: 'invalid_json_arguments' };
  }
  const schema = z.object(def.inputShape);
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: 'validation',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  try {
    const result = await def.handler(parsed.data, ctx);
    // Handler may return the rawContent sentinel (attachments). Collapse
    // to a legible marker so the LLM gets text, not binary bytes.
    if (
      result &&
      typeof result === 'object' &&
      '_mcpContent' in (result as Record<string, unknown>)
    ) {
      return {
        ok: true,
        note: 'binary content (image/resource) returned; summarise for the user, do not try to display raw bytes',
      };
    }
    return { ok: true, data: projectListResult(call.name, result) };
  } catch (err) {
    return {
      error: 'handler_threw',
      message: (err as Error).message.slice(0, 300),
    };
  }
}

// ---------------------------------------------------------------------------
// Slim projection for list-style returns. Full markdown bodies must NEVER
// land in the chat transcript — they re-inflate every turn and burn the
// LLM's context window. See `serialize.ts` for the byte-budget layer that
// runs after this projection.
// ---------------------------------------------------------------------------

const BODY_SNIPPET_LEN = 240;

interface SlimNote {
  id: string;
  folderId: string | null;
  title: string;
  status: string;
  tags: string[];
  pinned: boolean;
  updatedAt: number;
  createdAt: number;
  bodySnippet: string | null;
}

function slimNote(n: unknown): SlimNote | unknown {
  if (!n || typeof n !== 'object') return n;
  const note = n as Record<string, unknown>;
  // Defensive: only slim things that actually look like a Note. If a
  // future tool returns a different array shape under one of these
  // names, we leave it alone instead of corrupting it.
  if (typeof note.id !== 'string' || !('body' in note)) return n;
  const body = typeof note.body === 'string' ? note.body : '';
  const snippet =
    body.length === 0
      ? null
      : body.length > BODY_SNIPPET_LEN
        ? body.slice(0, BODY_SNIPPET_LEN) + '…'
        : body;
  return {
    id: note.id as string,
    folderId: (note.folderId ?? null) as string | null,
    title: (note.title ?? '') as string,
    status: (note.status ?? 'note') as string,
    tags: Array.isArray(note.tags) ? (note.tags as string[]) : [],
    pinned: Boolean(note.pinned),
    updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : 0,
    createdAt: typeof note.createdAt === 'number' ? note.createdAt : 0,
    bodySnippet: snippet,
  };
}

/**
 * Apply slim projection to known list-style tool returns so the chat
 * transcript doesn't carry full markdown bodies. Unknown shapes pass
 * through unchanged.
 */
function projectListResult(toolName: string, data: unknown): unknown {
  if (toolName === 'notes_list' || toolName === 'notes_recent') {
    return Array.isArray(data) ? data.map(slimNote) : data;
  }
  if (toolName === 'tasks_list') {
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray((data as { tasks?: unknown }).tasks)
    ) {
      const obj = data as Record<string, unknown>;
      return { ...obj, tasks: (obj.tasks as unknown[]).map(slimNote) };
    }
    return data;
  }
  return data;
}
