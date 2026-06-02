import { describe, it, expect } from 'vitest';
import {
  type NoteRow,
  tristate,
  rowToNote,
  bodyStartsWithTitle,
} from '../src/core/notes/repository/mappers.js';
import {
  SELECT_COLUMNS,
  SELECT_COLUMNS_N,
  POSITION_GAP,
} from '../src/core/notes/repository/queries.js';

const baseRow = (): NoteRow => ({
  id: '01ABC',
  folder_id: 'f1',
  title: 'T',
  body: '# T\n\nbody',
  pinned: 0,
  source: 'user',
  created_at: 1_000,
  updated_at: 2_000,
  deleted_at: null,
  archived_at: null,
  status: 'note',
  position: null,
  workflow_id: null,
  mcp_visible: null,
  mcp_update: null,
  mcp_delete: null,
});

describe('tristate', () => {
  it('null → null (inheritance from default)', () => {
    expect(tristate(null)).toBeNull();
  });

  it('1 → true (allowed)', () => {
    expect(tristate(1)).toBe(true);
  });

  it('0 → false (denied)', () => {
    expect(tristate(0)).toBe(false);
  });
});

describe('rowToNote', () => {
  it('projects every column with type coercions', () => {
    const row = baseRow();
    row.pinned = 1;
    row.mcp_visible = 1;
    row.mcp_update = 0;
    // mcp_delete stays null → inherits

    const note = rowToNote(row, ['alpha', 'beta']);
    expect(note).toEqual({
      id: '01ABC',
      folderId: 'f1',
      title: 'T',
      body: '# T\n\nbody',
      pinned: true,
      source: 'user',
      createdAt: 1_000,
      updatedAt: 2_000,
      deletedAt: null,
      archivedAt: null,
      status: 'note',
      position: null,
      workflowId: null,
      tags: ['alpha', 'beta'],
      mcpPermissions: {
        visible: true,
        update: false,
        delete: null,
      },
    });
  });

  it('preserves null timestamps + position', () => {
    const note = rowToNote(baseRow(), []);
    expect(note.deletedAt).toBeNull();
    expect(note.archivedAt).toBeNull();
    expect(note.position).toBeNull();
    expect(note.tags).toEqual([]);
  });

  it('passes through non-default kanban status string', () => {
    const row = baseRow();
    row.status = 'doing';
    row.position = 1.5;
    expect(rowToNote(row, [])).toMatchObject({ status: 'doing', position: 1.5 });
  });
});

describe('bodyStartsWithTitle', () => {
  it('matches exact title prefix', () => {
    expect(bodyStartsWithTitle('Hello world\n\nbody', 'Hello world')).toBe(true);
  });

  it('matches with leading whitespace', () => {
    expect(bodyStartsWithTitle('   \n  Hello', 'Hello')).toBe(true);
  });

  it('matches `# Title`, `## Title`, `### Title` heading prefixes', () => {
    expect(bodyStartsWithTitle('# Hello\n\nbody', 'Hello')).toBe(true);
    expect(bodyStartsWithTitle('## Hello\n\nbody', 'Hello')).toBe(true);
    expect(bodyStartsWithTitle('### Hello\n\nbody', 'Hello')).toBe(true);
  });

  it('rejects when title is mid-line', () => {
    expect(bodyStartsWithTitle('something else: Hello', 'Hello')).toBe(false);
  });

  it('rejects deeper headings (#### and below)', () => {
    // Only #, ##, ### are recognised — #### would be unusual for a note
    // title and the contract pins exactly the three levels.
    expect(bodyStartsWithTitle('#### Hello', 'Hello')).toBe(false);
  });
});

describe('queries module — column-list source of truth', () => {
  it('SELECT_COLUMNS lists exactly the NoteRow columns', () => {
    const cols = SELECT_COLUMNS.split(',').map((c) => c.trim()).filter(Boolean);
    expect(cols).toEqual([
      'id',
      'folder_id',
      'title',
      'body',
      'pinned',
      'source',
      'created_at',
      'updated_at',
      'deleted_at',
      'archived_at',
      'status',
      'position',
      'workflow_id',
      'mcp_visible',
      'mcp_update',
      'mcp_delete',
    ]);
  });

  it('SELECT_COLUMNS_N prefixes every column with `n.`', () => {
    const prefixed = SELECT_COLUMNS_N.split(',').map((c) => c.trim());
    for (const c of prefixed) {
      expect(c.startsWith('n.')).toBe(true);
    }
    expect(prefixed).toContain('n.id');
    expect(prefixed).toContain('n.mcp_delete');
  });

  it('POSITION_GAP is 1.0 (kanban midpoint-insert default)', () => {
    expect(POSITION_GAP).toBe(1.0);
  });
});
