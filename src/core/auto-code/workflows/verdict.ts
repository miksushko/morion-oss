/**
 * Auto-code Workflow Builder L2.T4b — review-stage verdict parser.
 *
 * Reviewers (codex / claude-fallback in the legacy orchestrator)
 * surface their decision in the stage's final summary text. The
 * parser tolerates three output shapes the underlying CLIs commonly
 * emit:
 *
 *   1. Bare JSON envelope (best case, --json-schema or strict prompt):
 *      `{"verdict": "approve", "reason": "..."}`
 *   2. Markdown-fenced JSON block: ```json {...} ```
 *   3. JSON embedded in narrative text — walk the whole string for
 *      balanced `{...}` blocks and try the latest one first (the
 *      verdict typically follows preamble).
 *
 * On failure (no parseable envelope) the parser returns
 * `{verdict: 'escalate', reason: 'reviewer produced no parseable verdict (unparseable output)'}`
 * — the runner then fails the run via the verdict policy's escalate
 * branch, surfacing the raw output to the user via `lastError`.
 *
 * Ported from `src/core/auto-code/codex-launcher.ts` (which itself
 * lands in T7's deletion list once the runner replaces the legacy
 * orchestrator). Kept verbatim re: brace-walker quote-aware logic so
 * the existing parseVerdict suite's expectations carry over.
 */

export type ReviewVerdict = 'approve' | 'reopen' | 'escalate';

export interface ParsedVerdict {
  verdict: ReviewVerdict;
  reason: string;
}

export function parseVerdict(text: string): ParsedVerdict {
  if (!text || typeof text !== 'string') return parseFailureVerdict();

  // Strategy 1: full-text parse (best case with --json-schema).
  const strategy1 = tryParseObject(text.trim());
  if (strategy1) return strategy1;

  // Strategy 2: strip ``` fences (json or bare) and try the inner
  // payload. Models often wrap JSON in ```json ... ```. Walk matches
  // in REVERSE order — when a reviewer includes a candidate / schema
  // example block before the corrected final verdict, the later
  // block is the load-bearing one (matches strategy 3's reasoning).
  const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenceMatches = [...text.matchAll(FENCE_RE)];
  for (let m = fenceMatches.length - 1; m >= 0; m--) {
    const inner = (fenceMatches[m]![1] ?? '').trim();
    const parsed = tryParseObject(inner);
    if (parsed) return parsed;
  }

  // Strategy 3: scan the WHOLE text for `{...}` blocks. Multi-line
  // capable, quote-aware so braces inside strings don't confuse the
  // depth counter. Walks the matches in reverse — the verdict is
  // typically the LAST JSON object, after any preamble.
  const blocks = extractJsonObjects(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(blocks[i]!);
    if (parsed) return parsed;
  }

  return parseFailureVerdict();
}

function parseFailureVerdict(): ParsedVerdict {
  return {
    verdict: 'escalate',
    reason: 'reviewer produced no parseable verdict (unparseable output)',
  };
}

function tryParseObject(candidate: string): ParsedVerdict | null {
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const v = obj.verdict;
      if (v === 'approve' || v === 'reopen' || v === 'escalate') {
        const reason = typeof obj.reason === 'string' ? obj.reason : '';
        return { verdict: v, reason };
      }
    }
  } catch {
    /* not parseable; fall through */
  }
  return null;
}

function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}
