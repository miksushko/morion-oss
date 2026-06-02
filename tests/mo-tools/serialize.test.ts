import { describe, expect, it } from 'vitest';
import {
  dispatchMoTool,
  serializeMoToolResultForChat,
} from '../../src/core/concierge/mo-tools.js';
import {
  tasksListTool,
  notesListTool,
  notesRecentTool,
  notesGetTool,
} from '../../src/server/tools/index.js';
import { buildRealCtx } from '../helpers/mo-tools-setup.js';

// Regression: chat-budget enforcement (the "51 notes / 1 task" bug,
// 2026-04-25). The pipeline used to do `JSON.stringify(result).slice(
// 0, 12_000)` which cut arrays mid-object — Mo would then "see" a
// single salvaged item and report phantom undercounts. The new
// pipeline slim-projects list returns and replaces oversize payloads
// with a structured truncation envelope (always valid JSON, always
// reports `total`). Pinned by the per-source-leaf split
// `src/core/concierge/mo-tools/serialize.ts` + `mo-tools/trim.ts`.

describe('serializeMoToolResultForChat — regression: chat-budget enforcement', () => {
  it('returns valid JSON and reports total=51 for a 51-card kanban board (the original bug)', async () => {
    const ctx = buildRealCtx();
    const folder = ctx.folders.create('Morion Features (test)');
    ctx.folders.setViewMode(folder.id, 'kanban');
    // 51 cards, each with a meaningfully-sized markdown body so the
    // pre-fix `JSON.stringify(...).slice(0, 12_000)` would have cut
    // mid-array. Bodies of ~600 chars each ⇒ raw JSON >30KB.
    for (let i = 0; i < 51; i++) {
      ctx.notes.create(
        {
          body: `# Ticket ${i}\n\n` + 'lorem ipsum dolor sit amet '.repeat(25),
          source: 'user',
          folderId: folder.id,
          status: i < 10 ? 'todo' : 'note',
        },
        'user',
      );
    }

    const env = await dispatchMoTool(
      [tasksListTool],
      { name: 'tasks_list', argumentsJson: JSON.stringify({ folderId: folder.id }) },
      ctx,
    );
    const { json, truncated, total } = serializeMoToolResultForChat('tasks_list', env);

    // Always-valid JSON — never the corrupt `.slice` fragment.
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as {
      ok: boolean;
      data: { folder: { id: string }; tasks?: unknown[]; total?: number; truncated?: boolean };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.folder.id).toBe(folder.id);
    // `total` from the helper reflects the real row count regardless of truncation.
    expect(total).toBe(51);
    // The transcript itself reports 51 either via tasks.length (no
    // truncation) or via data.total (truncated envelope).
    const transcriptTotal = parsed.data.truncated
      ? parsed.data.total
      : (parsed.data.tasks?.length ?? null);
    expect(transcriptTotal).toBe(51);
    // Either way, payload stays inside the budget.
    expect(json.length).toBeLessThanOrEqual(12_000);
    // Likely truncated given 51×600-char bodies, but not asserted —
    // slim-projection might fit in budget on smaller fixtures.
    void truncated;
  });

  it('slim-projects notes_list — body is dropped in favour of bodySnippet', async () => {
    const ctx = buildRealCtx();
    const folder = ctx.folders.create('Folder A');
    ctx.notes.create(
      {
        body: '# Long body\n\n' + 'x'.repeat(5000),
        source: 'user',
        folderId: folder.id,
      },
      'user',
    );

    const env = await dispatchMoTool(
      [notesListTool],
      { name: 'notes_list', argumentsJson: JSON.stringify({ folderId: folder.id }) },
      ctx,
    );
    const { json } = serializeMoToolResultForChat('notes_list', env);
    const parsed = JSON.parse(json) as { ok: boolean; data: unknown };
    expect(parsed.ok).toBe(true);
    // Whether or not truncation kicked in, the payload must NOT carry
    // the full body string (5000-char x-run).
    expect(json).not.toContain('x'.repeat(500));
    // Slim shape exposes bodySnippet, not body.
    expect(json).toContain('bodySnippet');
  });

  it('caps notes_get body when a single note exceeds the chat budget', async () => {
    const ctx = buildRealCtx();
    const note = ctx.notes.create(
      { body: 'A'.repeat(40_000), source: 'user' },
      'user',
    );
    const env = await dispatchMoTool(
      [notesGetTool],
      { name: 'notes_get', argumentsJson: JSON.stringify({ id: note.id }) },
      ctx,
    );
    const { json, truncated } = serializeMoToolResultForChat('notes_get', env);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(truncated).toBe(true);
    const parsed = JSON.parse(json) as {
      ok: boolean;
      data: { id: string; body: string; truncated: boolean; bodyTotalLength: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.id).toBe(note.id);
    expect(parsed.data.bodyTotalLength).toBe(40_000);
    expect(parsed.data.body.length).toBeLessThan(40_000);
    expect(json.length).toBeLessThanOrEqual(12_000);
  });

  it('passes small list results through unchanged (no truncation envelope)', async () => {
    const ctx = buildRealCtx();
    const folder = ctx.folders.create('Small');
    ctx.notes.create({ body: 'short', source: 'user', folderId: folder.id }, 'user');

    const env = await dispatchMoTool(
      [notesRecentTool],
      { name: 'notes_recent', argumentsJson: JSON.stringify({ limit: 5 }) },
      ctx,
    );
    const { truncated, total } = serializeMoToolResultForChat('notes_recent', env);
    expect(truncated).toBe(false);
    expect(total).toBe(1);
  });

  it('never produces a sliced/corrupt JSON string for any oversize payload', async () => {
    const ctx = buildRealCtx();
    const folder = ctx.folders.create('Big');
    ctx.folders.setViewMode(folder.id, 'kanban');
    // Push a deliberately huge fixture: 200 notes × 2KB body. Slim
    // projection brings notes down to ~400 bytes each, but truncation
    // still has to kick in to fit 12KB.
    for (let i = 0; i < 200; i++) {
      ctx.notes.create(
        {
          body: 'y'.repeat(2_000),
          source: 'user',
          folderId: folder.id,
          status: 'todo',
        },
        'user',
      );
    }
    const env = await dispatchMoTool(
      [tasksListTool],
      { name: 'tasks_list', argumentsJson: JSON.stringify({ folderId: folder.id, limit: 500 }) },
      ctx,
    );
    const { json, truncated, total } = serializeMoToolResultForChat('tasks_list', env);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(truncated).toBe(true);
    expect(total).toBe(200);
    expect(json.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(json) as { data: { total: number; returned: number } };
    expect(parsed.data.total).toBe(200);
    expect(parsed.data.returned).toBeGreaterThan(0);
    expect(parsed.data.returned).toBeLessThan(200);
  });

  // v1.4.2 incident (2026-05-04): chat-tier Mo dispatched mo_get_context,
  // gather returned a 14kB packet, the old trim path had no
  // mo_get_context branch → fell through to the "Unknown oversize
  // shape" stub `{error: 'payload_too_large', tool: 'mo_get_context',
  // hint: '...'}`. Next chat turn (Gemini Flash Lite taking over the
  // chat-tier voice from deepseek/qwen synthesis) saw the stub
  // instead of the actual synthesis → "deepseek ответил, а Gemini
  // лишился контекста". Pin the new shrink path that keeps
  // packetMarkdown intact (tail-trimmed if needed) so chat continuity
  // survives oversize gather packets.
  it('mo_get_context oversize packet — trims packetMarkdown but never returns payload_too_large stub', () => {
    const fullMarkdown = '# Synthesis\n\n' + 'lorem ipsum '.repeat(2000); // ~25kB
    const envelope = {
      ok: true,
      data: {
        mode: 'full',
        scope: 'folder',
        packetMarkdown: fullMarkdown,
        citedNoteIds: ['01HABC', '01HDEF'],
        risks: ['watch out for X'],
        bootstrap: {
          taskId: '01HTASK',
          folderId: '01HFOLDER',
          clusterIds: ['cluster-a', 'cluster-b'],
          commentCount: 12,
          auditCount: 5,
        },
        cacheHit: null,
        spentUsd: 0.018,
        capped: null,
        warnings: ['Wave 1 had 2/10 sub-Mos fail'],
        ranAs: 'morion-concierge',
      },
    };
    const { json, truncated } = serializeMoToolResultForChat('mo_get_context', envelope);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(truncated).toBe(true);
    expect(json.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(json) as {
      ok: boolean;
      error?: string;
      data: {
        packetMarkdown: string;
        citedNoteIds: string[];
        risks: string[];
        truncated: boolean;
        markdownTotalLength: number;
      };
    };
    expect(parsed.ok).toBe(true);
    // The crucial regression — must NOT be the generic stub.
    expect(parsed.error).toBeUndefined();
    // citedNoteIds + risks survive (next turn needs them).
    expect(parsed.data.citedNoteIds).toEqual(['01HABC', '01HDEF']);
    expect(parsed.data.risks).toEqual(['watch out for X']);
    // packetMarkdown is trimmed but recognisable.
    expect(parsed.data.packetMarkdown).toContain('Synthesis');
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.markdownTotalLength).toBe(fullMarkdown.length);
  });

  it('mo_get_context small packet — passes through untrimmed', () => {
    const envelope = {
      ok: true,
      data: {
        mode: 'full',
        scope: 'folder',
        packetMarkdown: '# Quick answer\n\nUse event.id for dedup.',
        citedNoteIds: ['01HABC'],
        risks: [],
        bootstrap: { taskId: null, folderId: null, clusterIds: [], commentCount: 0, auditCount: 0 },
        cacheHit: null,
        spentUsd: 0.005,
        capped: null,
        warnings: [],
        ranAs: 'morion-concierge',
      },
    };
    const { json, truncated } = serializeMoToolResultForChat('mo_get_context', envelope);
    expect(truncated).toBe(false);
    expect(json).toContain('Use event.id for dedup');
  });

  it('mo_ask oversize answer — same shrink, keeps answer + sources', () => {
    const fullAnswer = 'paragraph one. ' + 'lorem ipsum dolor sit amet '.repeat(800); // ~22kB
    const envelope = {
      ok: true,
      data: {
        ok: true,
        answer: fullAnswer,
        sources: [
          { kind: 'note', id: '01HABC', title: 'Stripe lessons', reason: 'extracted' },
          { kind: 'note', id: '01HDEF', title: 'Webhook idempotency', reason: 'extracted' },
        ],
        keywords: [],
        clusterRoutes: ['stripe'],
        notesScanned: 2,
        folder: { id: '01HFOLDER', name: 'Project A' },
        model: 'deepseek/deepseek-v4-flash',
        costUsd: 0.018,
        cacheHit: null,
        risks: [],
        warnings: [],
      },
    };
    const { json, truncated } = serializeMoToolResultForChat('mo_ask', envelope);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(truncated).toBe(true);
    expect(json.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(json) as {
      ok: boolean;
      error?: string;
      data: { answer: string; citedNoteIds: unknown; truncated: boolean };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data.answer).toContain('paragraph one');
    expect(parsed.data.truncated).toBe(true);
  });
});
