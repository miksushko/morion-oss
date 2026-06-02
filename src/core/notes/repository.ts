import type Database from 'better-sqlite3';
import type { AuditLogger } from '../audit/log.js';
import type {
  Note,
  NoteCreateInput,
  NoteListFilters,
  NoteStatus,
  NoteUpdateInput,
  TasksListFilters,
} from './types.js';
import { create as createNote } from './repository/create.js';
import { getById, list, count, recent } from './repository/read.js';
import { update as updateNote } from './repository/update.js';
import {
  deleteNote,
  archive as archiveNote,
  unarchive as unarchiveNote,
} from './repository/lifecycle.js';
import {
  listTrashed,
  restore as restoreNote,
  purgeOlderThan,
  purge as purgeNote,
  hardDelete as hardDeleteNote,
  purgeAllTrashed,
} from './repository/trash.js';
import {
  listKanban,
  moveToKanban,
  claimTask,
} from './repository/kanban.js';
import { setMcpPermissions } from './repository/mcp-perms.js';

/**
 * Thin shell over the per-domain repository helpers under
 * `repository/`. Each method delegates to a pure function that takes
 * `(db, audit, ...)` so unit tests can target the helpers directly
 * without instantiating the class. The class shape (and method
 * signatures) is the stable public surface — see
 * `tests/notes/*.test.ts` for the contract pins.
 */
export class NotesRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly audit: AuditLogger,
  ) {}

  create(input: NoteCreateInput, actor: string): Note {
    return createNote(this.db, this.audit, input, actor);
  }

  getById(
    id: string,
    options: { audit?: boolean; actor?: string; includeTrashed?: boolean } = {},
  ): Note | null {
    return getById(this.db, this.audit, id, options);
  }

  list(filters: NoteListFilters): Note[] {
    return list(this.db, filters);
  }

  count(filters: Omit<NoteListFilters, 'limit' | 'offset'>): number {
    return count(this.db, filters);
  }

  recent(
    limit: number,
    options?: { includeArchived?: boolean; includeMoSystem?: boolean },
  ): Note[] {
    return recent(this.db, limit, options);
  }

  update(id: string, input: NoteUpdateInput, actor: string): Note | null {
    return updateNote(this.db, this.audit, id, input, actor);
  }

  delete(id: string, actor: string): boolean {
    return deleteNote(this.db, this.audit, id, actor);
  }

  archive(id: string, actor: string): boolean {
    return archiveNote(this.db, this.audit, id, actor);
  }

  unarchive(id: string, actor: string): boolean {
    return unarchiveNote(this.db, this.audit, id, actor);
  }

  listTrashed(cutoff: number): Note[] {
    return listTrashed(this.db, cutoff);
  }

  restore(id: string, actor: string): Note | null {
    return restoreNote(this.db, this.audit, id, actor);
  }

  purgeOlderThan(cutoff: number): string[] {
    return purgeOlderThan(this.db, cutoff);
  }

  purge(id: string, actor: string): boolean {
    return purgeNote(this.db, this.audit, id, actor);
  }

  hardDelete(id: string, actor: string): boolean {
    return hardDeleteNote(this.db, this.audit, id, actor);
  }

  purgeAllTrashed(): string[] {
    return purgeAllTrashed(this.db);
  }

  listKanban(filters: TasksListFilters & { includeArchived?: boolean }): Note[] {
    return listKanban(this.db, filters);
  }

  moveToKanban(
    id: string,
    status: NoteStatus,
    afterNoteId: string | null | undefined,
    actor: string,
  ): Note | null {
    return moveToKanban(this.db, this.audit, id, status, afterNoteId, actor);
  }

  claimTask(id: string, actor: string): { claimed: boolean; note: Note | null } {
    return claimTask(this.db, this.audit, id, actor);
  }

  setMcpPermissions(
    id: string,
    perms: { visible: boolean | null; update: boolean | null; delete: boolean | null },
  ): Note | null {
    return setMcpPermissions(this.db, this.audit, id, perms);
  }
}
