import type {
  CommentLine,
  RelatedTicket,
  StatusEntry,
} from './types.js';

/**
 * Renderers — each returns a markdown chunk OR empty string when
 * source is empty. Empty chunks are dropped by the orchestrator in
 * compose.
 */

export function renderRepoConventions(content: string): string {
  if (content.length === 0) return '';
  return `# Repository conventions\n\n${content.trim()}`;
}

export function renderProjectMemory(overview: string): string {
  if (overview.length === 0) return '';
  return `# Project memory\n\n${overview}`;
}

export function renderUserPreferences(memory: string): string {
  if (memory.length === 0) return '';
  return `# User preferences (Mo Memory)\n\n${memory}`;
}

export function renderRelatedTickets(tickets: RelatedTicket[]): string {
  if (tickets.length === 0) return '';
  const lines = tickets.map(
    (t) => `- ${t.id} **${t.title}** — ${t.bodySnippet || '(no body)'}`,
  );
  return `# Related tickets in this project\n\n${lines.join('\n')}`;
}

export function renderAcceptance(content: string): string {
  if (content.length === 0) return '';
  return `# Acceptance criteria\n\n${content.trim()}`;
}

export function renderTask(title: string, body: string): string {
  // Note bodies typically begin with their own `# title` heading
  // (NotesRepository derives the title from that line). To avoid
  // duplicating it, prefer the body verbatim when present and only
  // synthesize a `## title` head when the body is empty.
  const trimmed = body.trim();
  if (trimmed.length === 0) return `# Your task\n\n## ${title}`;
  return `# Your task\n\n${trimmed}`;
}

export function renderRecentComments(items: CommentLine[]): string {
  if (items.length === 0) return '';
  const lines = items.map((c) => {
    const when = new Date(c.createdAt).toISOString();
    return `- **${c.actor}** at ${when}: ${c.body}`;
  });
  return `# Recent comments\n\n${lines.join('\n')}`;
}

export function renderStatusHistory(items: StatusEntry[]): string {
  if (items.length === 0) return '';
  const lines = items.map((e) => {
    const when = new Date(e.ts).toISOString();
    const arrow = e.from ? `${e.from} → ${e.to}` : `→ ${e.to}`;
    return `- ${when} (${e.actor}): ${arrow}`;
  });
  return `# Status history\n\n${lines.join('\n')}`;
}
