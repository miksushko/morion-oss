import { describe, it, expect, beforeEach } from 'vitest';
import { createKanbanFolder, setup, type Ctx } from '../helpers/tasks-setup.js';

describe('Direction N — Kanban data layer', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('schema / defaults', () => {
    it('creates folders with view_mode=list by default', () => {
      const f = ctx.tc.folders.create('General');
      expect(f.viewMode).toBe('list');
    });

    it('creates notes with status=note and null position by default', () => {
      const n = ctx.tc.notes.create({ body: 'hi', source: 'user' }, 'user');
      expect(n.status).toBe('note');
      expect(n.position).toBeNull();
    });

    it('setViewMode flips kanban and back, data-preserving', async () => {
      const f = ctx.tc.folders.create('Project');
      const kanban = ctx.tc.folders.setViewMode(f.id, 'kanban');
      expect(kanban?.viewMode).toBe('kanban');
      const note = ctx.tc.notes.create({ body: 'task', source: 'user', folderId: f.id, status: 'todo' }, 'user');
      expect(note.status).toBe('todo');

      const back = ctx.tc.folders.setViewMode(f.id, 'list');
      expect(back?.viewMode).toBe('list');
      // Status survives the flip
      const preserved = ctx.tc.notes.getById(note.id);
      expect(preserved?.status).toBe('todo');
      const again = ctx.tc.folders.setViewMode(f.id, 'kanban');
      expect(again?.viewMode).toBe('kanban');
      const restored = ctx.tc.notes.getById(note.id);
      expect(restored?.status).toBe('todo');
    });
  });

  describe('NotesRepository.create with explicit status', () => {
    it('respects explicit status and assigns position for manual-order columns', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const a = ctx.tc.notes.create(
        { body: 'task A', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const b = ctx.tc.notes.create(
        { body: 'task B', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      expect(a.status).toBe('todo');
      expect(b.status).toBe('todo');
      expect(a.position).not.toBeNull();
      expect(b.position).not.toBeNull();
      // B was created later and both default to top-of-column ⇒ B has the
      // lower (earlier) position. Sibling A shifts down by the new top.
      expect(b.position!).toBeLessThan(a.position!);
    });

    it('leaves position null for status=note (chronological column)', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 'idea', source: 'user', folderId: f.id, status: 'note' },
        'user',
      );
      expect(n.status).toBe('note');
      expect(n.position).toBeNull();
    });
  });

  describe('moveToKanban', () => {
    it('flips status, writes an audit row, does NOT bump updated_at', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 'task', source: 'user', folderId: f.id, status: 'backlog' },
        'user',
      );
      const originalUpdatedAt = n.updatedAt;

      await new Promise((r) => setTimeout(r, 5));

      const moved = ctx.tc.notes.moveToKanban(n.id, 'doing', null, 'mcp:agent');
      expect(moved?.status).toBe('doing');
      expect(moved?.updatedAt).toBe(originalUpdatedAt);

      const history = ctx.tc.audit.statusHistory(n.id, 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        statusFrom: 'backlog',
        statusTo: 'doing',
        actor: 'mcp:agent',
      });
    });

    it('pure intra-column reorder writes nothing to audit', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const a = ctx.tc.notes.create(
        { body: 'A', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const b = ctx.tc.notes.create(
        { body: 'B', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      ctx.tc.notes.moveToKanban(a.id, 'todo', b.id, 'user');
      const history = ctx.tc.audit.statusHistory(a.id, 10);
      expect(history).toHaveLength(0);
    });

    it('clears position when moving into the note column', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 't', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      expect(n.position).not.toBeNull();
      const moved = ctx.tc.notes.moveToKanban(n.id, 'note', null, 'user');
      expect(moved?.status).toBe('note');
      expect(moved?.position).toBeNull();
    });

    it('inserts a midpoint between two neighbours', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      // Create three cards in todo: positions ~= [1.0, 0.0, -1.0] (newest on top)
      const a = ctx.tc.notes.create(
        { body: 'A', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const b = ctx.tc.notes.create(
        { body: 'B', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const c = ctx.tc.notes.create(
        { body: 'C', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      // Move A between C (top) and B (middle). afterNoteId=C means "just below C".
      const moved = ctx.tc.notes.moveToKanban(a.id, 'todo', c.id, 'user');
      const cFresh = ctx.tc.notes.getById(c.id)!;
      const bFresh = ctx.tc.notes.getById(b.id)!;
      // New ordering in ascending position: C, A, B (C top, B bottom)
      expect(moved!.position).toBeGreaterThan(cFresh.position!);
      expect(moved!.position).toBeLessThan(bFresh.position!);
    });

    it('survives 50 midpoint inserts between the same two neighbours', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const top = ctx.tc.notes.create(
        { body: 'top', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const bottom = ctx.tc.notes.create(
        { body: 'bot', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      // bottom was created last so its position < top (newest-on-top convention).
      // Reverse: we want `top` to be the topmost. Create a third middle card
      // each iteration and verify its position is distinct and ordered.
      const seenPositions = new Set<number>();
      for (let i = 0; i < 50; i++) {
        const mid = ctx.tc.notes.create(
          { body: `m${i}`, source: 'user', folderId: f.id, status: 'todo' },
          'user',
        );
        // Move mid between top and bottom (top is higher position, bottom lower)
        // Actually bottom has the lower position. afterNoteId=top means
        // insert "below top" which places mid between top and whatever is next.
        const moved = ctx.tc.notes.moveToKanban(mid.id, 'todo', top.id, 'user');
        expect(moved?.position).toBeDefined();
        expect(seenPositions.has(moved!.position!)).toBe(false);
        seenPositions.add(moved!.position!);
      }
      // All positions distinct ⇒ no collision, precision held
      expect(seenPositions.size).toBe(50);
      void bottom;
    });
  });

  describe('claimTask', () => {
    it('claims a todo task atomically, writes audit', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 't', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const result = ctx.tc.notes.claimTask(n.id, 'mcp:agent-1');
      expect(result.claimed).toBe(true);
      expect(result.note?.status).toBe('doing');
      const history = ctx.tc.audit.statusHistory(n.id, 5);
      expect(history[0]).toMatchObject({ statusFrom: 'todo', statusTo: 'doing' });
    });

    it('second claim on an already-doing task returns claimed:false', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 't', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const first = ctx.tc.notes.claimTask(n.id, 'mcp:agent-1');
      expect(first.claimed).toBe(true);
      const second = ctx.tc.notes.claimTask(n.id, 'mcp:agent-2');
      expect(second.claimed).toBe(false);
      expect(second.note?.status).toBe('doing'); // still doing from the first claim
      // Only one audit row for the transition — agent-2's failed claim writes nothing
      const history = ctx.tc.audit.statusHistory(n.id, 10);
      expect(history).toHaveLength(1);
      expect(history[0]?.actor).toBe('mcp:agent-1');
    });

    it('rejects claim on a non-todo task (e.g. backlog)', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const n = ctx.tc.notes.create(
        { body: 't', source: 'user', folderId: f.id, status: 'backlog' },
        'user',
      );
      const r = ctx.tc.notes.claimTask(n.id, 'user');
      expect(r.claimed).toBe(false);
      expect(r.note?.status).toBe('backlog');
    });
  });

  describe('listKanban', () => {
    it('orders columns note → backlog → todo → doing → review → done', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      const statuses = ['done', 'review', 'doing', 'todo', 'backlog', 'note'] as const;
      for (const s of statuses) {
        ctx.tc.notes.create(
          { body: `card-${s}`, source: 'user', folderId: f.id, status: s },
          'user',
        );
      }
      const results = ctx.tc.notes.listKanban({ folderId: f.id, limit: 100 });
      const orderedStatuses = results.map((n) => n.status);
      expect(orderedStatuses).toEqual(['note', 'backlog', 'todo', 'doing', 'review', 'done']);
    });

    it('note column sorts by updated_at desc; manual columns by position asc', async () => {
      const f = await createKanbanFolder(ctx, 'P');
      // Two note-column cards with different updated_at
      const idea1 = ctx.tc.notes.create(
        { body: 'idea 1', source: 'user', folderId: f.id, status: 'note' },
        'user',
      );
      await new Promise((r) => setTimeout(r, 5));
      const idea2 = ctx.tc.notes.create(
        { body: 'idea 2', source: 'user', folderId: f.id, status: 'note' },
        'user',
      );
      // Bump idea1's updated_at by editing body
      await new Promise((r) => setTimeout(r, 5));
      ctx.tc.notes.update(idea1.id, { body: 'idea 1 edited' }, 'user');

      const noteColumn = ctx.tc.notes.listKanban({ folderId: f.id, status: 'note' });
      // Most recently edited first
      expect(noteColumn[0]?.id).toBe(idea1.id);
      expect(noteColumn[1]?.id).toBe(idea2.id);
    });
  });
});
