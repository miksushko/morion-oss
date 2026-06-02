import type { NotesRepository } from '../notes/repository.js';
import type { FoldersRepository } from '../folders/repository.js';
import type { HybridSearch } from '../search/hybrid.js';
import type Database from 'better-sqlite3';
import {
  folderTaskSummary,
  agentClaims,
  staleTasks,
  folderActivityDelta,
} from './activity.js';
import type { LLMToolDefinition } from './provider.js';

/**
 * Direction V Phase V7 — read-only tool kit exposed to Mo inside a
 * chat session.
 *
 * Every tool is strictly read-only. Writes only happen during a board
 * tick via `CONCIERGE_TOOLS` — chat Mo is an advisor, not an executor.
 * The dispatcher below runs each call synchronously against existing
 * repos; results are serialised back into a `role='tool'` message so
 * the model can observe them on its next turn.
 *
 * Scope: whole workspace. Mo needs to answer questions like "what did
 * claude-code ship yesterday?" which cross folder boundaries. The
 * action-tier allowlist for WRITES stays folder-scoped; reads are open.
 */

// JSON Schema strictness notes for Groq / gpt-oss "harmony" tokenizer
// (which rejects several otherwise-valid JSON Schema constructs):
//   - NO `default` values — must be encoded in the description text.
//   - NO array `type` unions like `['string', 'null']` — use a single
//     string type + describe nullability in the description, dispatcher
//     interprets missing/empty as null.
//   - `minimum` / `maximum` OK on number types.
//   - `additionalProperties: false` OK and encouraged.
// Dispatchers in chat-tools.ts apply these defaults when the arg is
// missing, so the end-user experience is unchanged.
export const CHAT_TOOLS: LLMToolDefinition[] = [
  {
    name: 'notes_search',
    description:
      'Hybrid keyword + semantic search across every non-deleted, non-archived note. Returns top matches with id, title, folderId, snippet. Use this whenever the user asks about past notes, decisions, or context. Prefer this over listing by folder.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language query.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Max hits to return. Default 8 when omitted.',
        },
      },
    },
  },
  {
    name: 'notes_get',
    description:
      'Fetch a single note by id with its full body and tags. Use after notes_search narrowed the candidate set.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId'],
      properties: { noteId: { type: 'string' } },
    },
  },
  {
    name: 'notes_list',
    description:
      "List notes in a folder, newest-first. Omit folderId (or pass an empty string) to list unfiled notes. Use when the user asks 'what's in folder X' or wants to scan a board at a glance.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folderId: {
          type: 'string',
          description:
            'Folder id to list. Pass empty string or omit entirely to list unfiled notes.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max notes. Default 20.',
        },
      },
    },
  },
  {
    name: 'folders_list',
    description:
      "List every folder in the workspace (id, name, viewMode='list'|'kanban'). Use when the user asks about folder structure or you need to pick a folderId for a follow-up call.",
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'folder_summary',
    description:
      'Count cards per kanban status in one folder (note / backlog / todo / doing / review / done). Stale cards in doing/review are surfaced too. Use this to answer "what does board X look like right now?" without pulling every card.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['folderId'],
      properties: {
        folderId: { type: 'string' },
        staleHours: {
          type: 'number',
          minimum: 0,
          description: 'Threshold for flagging stale cards. Default 2.',
        },
      },
    },
  },
  {
    name: 'recent_activity',
    description:
      "Raw activity delta in one folder: status transitions, new comments, new notes within the last N hours. Use when the user asks 'what happened here?' or you need evidence for a workflow answer.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['folderId'],
      properties: {
        folderId: { type: 'string' },
        hours: {
          type: 'number',
          minimum: 0.25,
          maximum: 720,
          description: 'Lookback window in hours. Default 24.',
        },
      },
    },
  },
  {
    name: 'agent_claims',
    description:
      "Distinct MCP actors (claude-code, cursor, etc.) who moved cards into 'doing' within a window, plus claim counts. Use to answer 'who's been active on this board?' or to notice a silent agent.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['folderId'],
      properties: {
        folderId: { type: 'string' },
        hours: {
          type: 'number',
          minimum: 0.25,
          maximum: 720,
          description: 'Lookback window. Default 24.',
        },
      },
    },
  },
];

export interface ChatToolDeps {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  search: HybridSearch;
}

/**
 * Dispatch a single tool call. Returns a JSON-serialisable payload
 * that the caller will stringify into a role='tool' message so the
 * model can use it on the next turn.
 *
 * Errors surface as `{ error }` payloads so the model gets to reason
 * about a failed lookup (usually bad id) rather than the whole chat
 * 500'ing. Unknown tool names → `{ error: 'unknown_tool' }`.
 */
export async function dispatchChatTool(
  name: string,
  argsJson: string,
  deps: ChatToolDeps,
): Promise<Record<string, unknown>> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return { error: 'invalid_json_arguments' };
  }

  switch (name) {
    case 'notes_search': {
      const query = String(args.query ?? '').slice(0, 500);
      const limit = Math.max(1, Math.min(Number(args.limit ?? 8), 20));
      if (!query.trim()) return { error: 'empty_query' };
      const hits = await deps.search.search(query, { limit });
      return {
        query,
        hits: hits.map((h) => ({
          id: h.note.id,
          title: h.note.title,
          folderId: h.note.folderId,
          snippet: h.snippet,
          score: h.score,
        })),
      };
    }
    case 'notes_get': {
      const noteId = String(args.noteId ?? '');
      if (!noteId) return { error: 'missing_noteId' };
      const n = deps.notes.getById(noteId);
      if (!n) return { error: 'not_found' };
      return {
        id: n.id,
        title: n.title,
        body: n.body.slice(0, 8_000),
        folderId: n.folderId,
        status: n.status,
        tags: n.tags,
        updatedAt: n.updatedAt,
      };
    }
    case 'notes_list': {
      // Empty string from the schema-restricted tool means "unfiled".
      // Null also accepted for clients that send JSON null explicitly.
      const raw = args.folderId;
      const folderId = raw === null || raw === undefined || raw === '' ? null : String(raw);
      const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 50));
      const items = deps.notes.list({ folderId, limit, offset: 0 });
      return {
        folderId,
        items: items.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          updatedAt: n.updatedAt,
        })),
      };
    }
    case 'folders_list': {
      const items = deps.folders.list();
      return {
        items: items.map((f) => ({
          id: f.id,
          name: f.name,
          viewMode: f.viewMode,
        })),
      };
    }
    case 'folder_summary': {
      const folderId = String(args.folderId ?? '');
      if (!folderId) return { error: 'missing_folderId' };
      const staleHours = Math.max(0, Number(args.staleHours ?? 2));
      const summary = folderTaskSummary(deps.db, folderId);
      const stale = staleTasks(deps.db, folderId, staleHours, ['doing', 'review']);
      return {
        ...summary,
        stale: stale.map((s) => ({
          noteId: s.noteId,
          title: s.title,
          status: s.status,
          staleHours: Math.round(s.staleMs / 360_000) / 10,
        })),
      };
    }
    case 'recent_activity': {
      const folderId = String(args.folderId ?? '');
      if (!folderId) return { error: 'missing_folderId' };
      const hours = Math.max(0.25, Math.min(Number(args.hours ?? 24), 720));
      const since = Date.now() - hours * 60 * 60 * 1000;
      const d = folderActivityDelta(deps.db, folderId, since);
      return {
        folderId,
        since: d.since,
        until: d.until,
        statusChanges: d.statusChanges.slice(0, 50),
        newComments: d.newComments.slice(0, 50).map((c) => ({
          noteId: c.noteId,
          actor: c.actor,
          snippet: c.body.slice(0, 240),
          createdAt: c.createdAt,
        })),
        newNotes: d.newNotes.slice(0, 50),
      };
    }
    case 'agent_claims': {
      const folderId = String(args.folderId ?? '');
      if (!folderId) return { error: 'missing_folderId' };
      const hours = Math.max(0.25, Math.min(Number(args.hours ?? 24), 720));
      const since = Date.now() - hours * 60 * 60 * 1000;
      return { folderId, claims: agentClaims(deps.db, folderId, since) };
    }
    default:
      return { error: 'unknown_tool', name };
  }
}
