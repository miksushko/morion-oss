import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditLogger } from '../../audit/log.js';
import type { NotesRepository } from '../../notes/repository.js';
import type { NoteCommentsRepository } from '../../notes/comments-repository.js';
import type { MoMemoryRepository } from '../../concierge/mo-memory.js';
import type { NoteMoClustersRepository } from '../../concierge/mo-clusters-repository.js';
import { findCatalogNoteId } from '../../concierge/mo-tier25.js';
import { parseCatalogDoc } from '../../concierge/mo-catalog-doc.js';
import {
  DEFAULT_CLAUDE_MD_CAP_CHARS,
  DEFAULT_RELATED_BODY_SNIPPET_CHARS,
  type CommentLine,
  type RelatedTicket,
  type StatusEntry,
} from './types.js';

/**
 * Source readers — each returns the raw content for one section. Pure
 * I/O against the passed-in repos / filesystem; no rendering, no
 * truncation decisions (those live in the orchestrator + renderers).
 */

export function readClaudeMd(repoPath: string): string {
  const candidate = join(repoPath, 'CLAUDE.md');
  if (!existsSync(candidate)) return '';
  try {
    const raw = readFileSync(candidate, 'utf8');
    if (raw.length <= DEFAULT_CLAUDE_MD_CAP_CHARS) return raw;
    // Soft-cap individual section before global truncation gets to
    // it — a 200KB CLAUDE.md would otherwise dominate the prompt.
    return raw.slice(0, DEFAULT_CLAUDE_MD_CAP_CHARS) + '\n\n…(truncated)';
  } catch {
    return '';
  }
}

export function readCatalogOverview(
  db: Database.Database,
  notes: NotesRepository,
  folderId: string,
): string {
  const id = findCatalogNoteId(db, folderId);
  if (!id) return '';
  const note = notes.getById(id);
  if (!note?.body) return '';
  const parsed = parseCatalogDoc(note.body);
  return (parsed.sections.overview ?? '').trim();
}

export function readMoMemory(moMemory: MoMemoryRepository): string {
  return moMemory.read().trim();
}

export function readRelatedTickets(
  clusters: NoteMoClustersRepository,
  notes: NotesRepository,
  taskId: string,
  folderId: string,
  limit: number,
): RelatedTicket[] {
  // 1. clusters this task belongs to
  const taskClusters = clusters.listForNote(taskId);
  if (taskClusters.length === 0) return [];

  // 2. all OTHER notes in those clusters, dedup on note id, pick top
  //    `limit` ranked by max confidence across overlapping clusters.
  const scoreById = new Map<string, number>();
  for (const tc of taskClusters) {
    const peers = clusters.listForCluster(tc.clusterId);
    for (const peer of peers) {
      if (peer.noteId === taskId) continue;
      const prev = scoreById.get(peer.noteId) ?? 0;
      const score = peer.confidence ?? 1.0;
      if (score > prev) scoreById.set(peer.noteId, score);
    }
  }
  const ranked = [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const result: RelatedTicket[] = [];
  for (const [noteId] of ranked) {
    const note = notes.getById(noteId);
    if (!note) continue;
    // Stay within folder — cross-folder noise dilutes the agent's
    // context window. Cluster ids are global, so a `kanban-ui`
    // cluster could pull notes from another project.
    if (note.folderId !== folderId) continue;
    const body = (note.body ?? '').trim();
    const bodySnippet =
      body.length > DEFAULT_RELATED_BODY_SNIPPET_CHARS
        ? body.slice(0, DEFAULT_RELATED_BODY_SNIPPET_CHARS) + '…'
        : body;
    result.push({ id: note.id, title: note.title, bodySnippet });
  }
  return result;
}

export function readRecentComments(
  comments: NoteCommentsRepository,
  taskId: string,
  limit: number,
): CommentLine[] {
  const page = comments.list(taskId, { limit });
  return page.items.map((c) => ({
    actor: c.actor,
    body: c.body,
    createdAt: c.createdAt,
  }));
}

export function readStatusHistory(
  audit: AuditLogger,
  taskId: string,
  limit: number,
): StatusEntry[] {
  return audit.statusHistory(taskId, limit).map((e) => ({
    from: e.statusFrom,
    to: e.statusTo,
    actor: e.actor,
    ts: e.timestamp,
  }));
}
