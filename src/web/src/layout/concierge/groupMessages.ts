import type { ConciergeMessage } from '../../lib/api';

/**
 * Display item kinds after collapsing tool pairs:
 * - `message`: plain user/assistant bubble, rendered as markdown.
 * - `tool-group`: the "(querying workspace: …)" assistant prefix + its
 *   subsequent role='tool' rows, folded into a single collapsible chip
 *   so the main transcript stays clean.
 */
export type DisplayItem =
  | { kind: 'message'; key: string; msg: ConciergeMessage }
  | {
      kind: 'tool-group';
      key: string;
      /** Optional prefix text the assistant wrote BEFORE the tool call
       * marker. Rare but legal — the model sometimes narrates
       * ("Let me check...") before the query line. */
      preface: string | null;
      calls: Array<{ name: string; args: string; result: string; id: string }>;
      timestamp: number;
    };

export const QUERY_MARKER = '(querying workspace:';

/**
 * Fold (assistant-with-querying-marker) + (following role='tool' rows)
 * into a single tool-group display item.
 */
export function groupMessages(messages: ConciergeMessage[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      // Orphan tool row (no preceding assistant marker) — skip. Should
      // not happen with current engine but be safe.
      i += 1;
      continue;
    }
    if (m.role === 'assistant' && m.content.includes(QUERY_MARKER)) {
      const preface = extractPreface(m.content);
      const queryLines = extractQueryLines(m.content);
      const calls: Array<{ name: string; args: string; result: string; id: string }> = [];
      let j = i + 1;
      for (const ql of queryLines) {
        const toolMsg = messages[j];
        if (toolMsg && toolMsg.role === 'tool') {
          calls.push({
            id: toolMsg.toolCallId ?? `c_${j}`,
            name: ql.name,
            args: ql.args,
            result: toolMsg.content,
          });
          j += 1;
        } else {
          calls.push({ id: `c_${j}`, name: ql.name, args: ql.args, result: '' });
        }
      }
      out.push({
        kind: 'tool-group',
        key: `group_${m.id}`,
        preface,
        calls,
        timestamp: m.createdAt,
      });
      i = j;
      continue;
    }
    out.push({ kind: 'message', key: m.id, msg: m });
    i += 1;
  }
  return out;
}

export function extractPreface(content: string): string | null {
  const idx = content.indexOf(QUERY_MARKER);
  if (idx <= 0) return null;
  const head = content.slice(0, idx).trim();
  return head || null;
}

export function extractQueryLines(content: string): Array<{ name: string; args: string }> {
  // Parse lines shaped like "- name(argsPreview)" after the marker.
  const idx = content.indexOf(QUERY_MARKER);
  if (idx < 0) return [];
  const tail = content.slice(idx);
  const lines = tail.split('\n').filter((l) => l.trim().startsWith('- '));
  return lines.map((l) => {
    const body = l.trim().replace(/^-\s*/, '');
    const m = body.match(/^([\w_.-]+)\((.*)\)$/);
    if (!m) return { name: body, args: '' };
    return { name: m[1]!, args: m[2]!.replace(/…$/, '') };
  });
}
