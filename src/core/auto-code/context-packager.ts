import {
  DEFAULT_COMMENT_LIMIT,
  DEFAULT_MAX_CHARS,
  DEFAULT_RELATED_LIMIT,
  DEFAULT_STATUS_HISTORY_LIMIT,
  SECTION_LABEL,
  type PackageCodingContextOptions,
  type PackagedCodingContext,
  type SectionDiagnostic,
} from './context-packager/types.js';
import {
  readCatalogOverview,
  readClaudeMd,
  readMoMemory,
  readRecentComments,
  readRelatedTickets,
  readStatusHistory,
} from './context-packager/readers.js';
import {
  renderAcceptance,
  renderProjectMemory,
  renderRecentComments,
  renderRelatedTickets,
  renderRepoConventions,
  renderStatusHistory,
  renderTask,
  renderUserPreferences,
} from './context-packager/renderers.js';
import {
  computeTotal,
  extractAcceptanceSection,
} from './context-packager/helpers.js';

export type {
  PackageCodingContextOptions,
  PackagedCodingContext,
  SectionDiagnostic,
} from './context-packager/types.js';

/**
 * Auto-code Phase 2 — coding context packager
 * (sub-ticket 01KQEECJV1WAGHK823T41SZ953, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * Composes the prompt the orchestrator (#6) feeds to claude/codex.
 * Different shape than the chat-tier `buildWorkContextPacket`:
 * single-task-focused, includes filesystem reads (CLAUDE.md from
 * the linked repo), grounds the agent in folder workflow + Mo
 * memory, and pulls related tickets via the Mo Indexing cluster
 * JOIN instead of pinned/tagged scoring.
 *
 * Sections rendered, in this order:
 *
 *   1. Repo conventions     — `<repoPath>/CLAUDE.md` if present
 *   2. Project memory       — mo:catalog overview section
 *   3. Workflow rules       — concierge_folder_settings.workflow
 *   4. User preferences     — mo.memory (workspace KV)
 *   5. Related tickets      — top 5 by note_mo_clusters JOIN
 *   6. Acceptance criteria  — hoisted from task body if it has
 *                              a `## Acceptance` section
 *   7. Your task            — title + body (with acceptance
 *                              elided if hoisted)
 *   8. Recent comments      — newest 10 on the task
 *   9. Status history       — last 10 audit entries on the task
 *
 * Truncation: when total chars > maxChars, drop sections in
 * least-important order until under budget. Order:
 *   related → comments → status history → CLAUDE.md → catalog
 * The TASK itself + acceptance + workflow + mo.memory are never
 * dropped (essential for the agent to do the work). If even the
 * essentials exceed the budget the function returns oversize
 * (caller can decide whether to error).
 *
 * Pure deterministic — no LLM call. The actionability evaluator
 * (#8) is the LLM-tier upstream gate; this just assembles strings.
 *
 * Implementation lives in sibling modules under `context-packager/`:
 *   types.ts      public types + constants + section-label map
 *   readers.ts    source readers (CLAUDE.md, catalog, mo.memory,
 *                  related tickets, comments, status history)
 *   renderers.ts  per-section markdown formatters
 *   helpers.ts    acceptance hoisting + truncation total math
 */
export function packageCodingContext(
  opts: PackageCodingContextOptions,
): PackagedCodingContext {
  const task = opts.notes.getById(opts.taskId);
  if (!task) {
    throw new Error(`packageCodingContext: task ${opts.taskId} not found`);
  }
  const folder = opts.folders.getById(opts.folderId);
  if (!folder) {
    throw new Error(`packageCodingContext: folder ${opts.folderId} not found`);
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const relatedLimit = opts.relatedLimit ?? DEFAULT_RELATED_LIMIT;
  const commentLimit = opts.commentLimit ?? DEFAULT_COMMENT_LIMIT;
  const statusHistoryLimit =
    opts.statusHistoryLimit ?? DEFAULT_STATUS_HISTORY_LIMIT;

  // Acceptance hoist: extract `## Acceptance` block from body if
  // present so the agent sees success criteria at the TOP of the
  // prompt instead of buried in the middle of a long task body.
  const { acceptance, taskBodyWithoutAcceptance } = extractAcceptanceSection(
    task.body ?? '',
  );

  // ---- Read every section unconditionally; drop later via truncation.
  const repoConventions = readClaudeMd(opts.repoPath);
  const projectMemory = readCatalogOverview(opts.db, opts.notes, opts.folderId);
  const userPrefs = readMoMemory(opts.moMemory);
  const relatedTickets = readRelatedTickets(
    opts.clusters,
    opts.notes,
    opts.taskId,
    opts.folderId,
    relatedLimit,
  );
  const recentComments = readRecentComments(
    opts.comments,
    opts.taskId,
    commentLimit,
  );
  const statusHistory = readStatusHistory(
    opts.audit,
    opts.taskId,
    statusHistoryLimit,
  );

  // ---- Render each section as markdown (may be empty when source
  // is empty; truncation logic below treats empty as "not included").
  const sectionsRendered = {
    'repo-conventions': renderRepoConventions(repoConventions),
    'project-memory': renderProjectMemory(projectMemory),
    'user-preferences': renderUserPreferences(userPrefs),
    'related-tickets': renderRelatedTickets(relatedTickets),
    acceptance: renderAcceptance(acceptance),
    task: renderTask(task.title, taskBodyWithoutAcceptance),
    'recent-comments': renderRecentComments(recentComments),
    'status-history': renderStatusHistory(statusHistory),
  } as const;

  // ---- Truncation: drop in least-important order until under cap.
  // Essential sections (task/acceptance/workflow/user-prefs) are
  // never dropped; if even those exceed the cap, surface `oversize`.
  const TRUNCATION_ORDER: Array<SectionDiagnostic['id']> = [
    'related-tickets',
    'recent-comments',
    'status-history',
    'repo-conventions',
    'project-memory',
  ];
  const dropped = new Set<SectionDiagnostic['id']>();
  let total = computeTotal(sectionsRendered, dropped);
  for (const id of TRUNCATION_ORDER) {
    if (total <= maxChars) break;
    if (sectionsRendered[id].length === 0) continue;
    dropped.add(id);
    total = computeTotal(sectionsRendered, dropped);
  }
  const oversize = total > maxChars;

  // ---- Compose final prompt in the documented order.
  const ORDER: SectionDiagnostic['id'][] = [
    'repo-conventions',
    'project-memory',
    'user-preferences',
    'related-tickets',
    'acceptance',
    'task',
    'recent-comments',
    'status-history',
  ];
  const parts: string[] = [];
  const sections: SectionDiagnostic[] = [];
  for (const id of ORDER) {
    const rendered = sectionsRendered[id];
    const truncated = dropped.has(id);
    const included = !truncated && rendered.length > 0;
    if (included) parts.push(rendered);
    sections.push({
      id,
      label: SECTION_LABEL[id],
      included,
      charCount: included ? rendered.length : 0,
      truncated,
    });
  }
  const prompt = parts.join('\n\n').trim() + '\n';
  return { prompt, sections, totalChars: prompt.length, oversize };
}
