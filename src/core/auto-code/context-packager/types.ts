import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import type { FoldersRepository } from '../../folders/repository.js';
import type { NotesRepository } from '../../notes/repository.js';
import type { NoteCommentsRepository } from '../../notes/comments-repository.js';
import type { MoMemoryRepository } from '../../concierge/mo-memory.js';
import type { NoteMoClustersRepository } from '../../concierge/mo-clusters-repository.js';

// ---------------------------------------------------------------------------
// Cap constants (shared across the assembly pipeline)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CHARS = 50_000;
export const DEFAULT_RELATED_LIMIT = 5;
export const DEFAULT_COMMENT_LIMIT = 10;
export const DEFAULT_STATUS_HISTORY_LIMIT = 10;
export const DEFAULT_CLAUDE_MD_CAP_CHARS = 30_000;
export const DEFAULT_RELATED_BODY_SNIPPET_CHARS = 200;

export const ACCEPTANCE_SECTION_RE =
  /(^|\n)\s*##\s+Acceptance(?:\s+criteria)?\s*\n([\s\S]*?)(?=\n\s*##\s+|\n*$)/i;

// ---------------------------------------------------------------------------
// Public types (re-exported by the shell)
// ---------------------------------------------------------------------------

export interface PackageCodingContextOptions {
  /** Task ULID being worked on. */
  taskId: string;
  /** Folder the task lives in (drives the catalog overview lookup). */
  folderId: string;
  /** Linked git repo root. CLAUDE.md is read from here. */
  repoPath: string;
  /** Output cap. Default 50_000 chars (rough fit for 100k-token
   *  input window with overhead). */
  maxChars?: number;
  /** Top-N related tickets to include via cluster JOIN. */
  relatedLimit?: number;
  /** Newest comments to include. */
  commentLimit?: number;
  /** Last status-history entries to include. */
  statusHistoryLimit?: number;

  // ----- Repository dependencies (orchestrator passes these from
  // the runtime container) ------------------------------------------------
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  audit: AuditLogger;
  clusters: NoteMoClustersRepository;
  moMemory: MoMemoryRepository;
}

export interface SectionDiagnostic {
  /** Stable section id for the activity surface (#10) */
  id:
    | 'repo-conventions'
    | 'project-memory'
    | 'user-preferences'
    | 'related-tickets'
    | 'acceptance'
    | 'task'
    | 'recent-comments'
    | 'status-history';
  /** Display label */
  label: string;
  /** True when the section ended up in the final prompt. False when
   *  empty source OR dropped by truncation. */
  included: boolean;
  /** Char count of the rendered section (0 when not included). */
  charCount: number;
  /** True when the section was dropped by truncation (vs simply
   *  empty/missing on the source). Useful for the activity surface
   *  to show "5 related tickets dropped to fit budget". */
  truncated: boolean;
}

export interface PackagedCodingContext {
  /** Final markdown prompt the launcher passes to claude. */
  prompt: string;
  /** Per-section breakdown for #10 activity surface. */
  sections: SectionDiagnostic[];
  totalChars: number;
  /** True when even the essential sections (task / acceptance /
   *  workflow / mo.memory) push over `maxChars`. Caller's
   *  responsibility to decide what to do (warn user / fail
   *  preflight / spawn anyway). */
  oversize: boolean;
}

// ---------------------------------------------------------------------------
// Internal collector return shapes (shared by readers + renderers)
// ---------------------------------------------------------------------------

export interface RelatedTicket {
  id: string;
  title: string;
  bodySnippet: string;
}

export interface CommentLine {
  actor: string;
  body: string;
  createdAt: number;
}

export interface StatusEntry {
  from: string | null;
  to: string;
  actor: string;
  ts: number;
}

export const SECTION_LABEL: Record<SectionDiagnostic['id'], string> = {
  'repo-conventions': 'Repository conventions',
  'project-memory': 'Project memory',
  'user-preferences': 'User preferences (Mo Memory)',
  'related-tickets': 'Related tickets in this project',
  acceptance: 'Acceptance criteria',
  task: 'Your task',
  'recent-comments': 'Recent comments',
  'status-history': 'Status history',
};
