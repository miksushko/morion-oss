import type { LLMProvider } from '../concierge/provider.js';

/**
 * AI merge-conflict resolver. Powers the "Try AI auto-resolve"
 * button inside ConflictResolverModal: takes the per-file ours/
 * theirs/merged content + ticket context and asks a frontier model
 * to produce a resolved file body that preserves both sides' intent.
 *
 * Two-model strategy (per design — see Morion note 01KRC9H18QDEHA18GVPEN9173A):
 *   - **Primary** = `deepseek-v4-pro` (UI placeholder default).
 *     High-quality reasoning, $0.435 / $0.87 per 1M tokens. The
 *     resolver's main workhorse.
 *   - **Fallback** = `claude-sonnet-4` (UI placeholder default).
 *     Fired when primary either throws (rate limit / network /
 *     refusal) OR returns malformed output (leftover conflict
 *     markers — see CONFLICT_MARKER_RE). $3.00 / $15.00 per 1M.
 *
 * Per-file calls run in parallel (Promise.all) — typical PR-style
 * conflicts touch 1-5 files; parallelism shaves total wall-clock.
 *
 * Pure helper — no DB writes, no ledger writes. Cost is returned in
 * the result envelope; the calling HTTP route is responsible for
 * `BudgetTracker.record` + budget cap pre-flight.
 *
 * Safety:
 *   - Output is validated against `CONFLICT_MARKER_RE` BEFORE
 *     returning. Models occasionally echo the conflict markers
 *     verbatim — that's a "I refuse to resolve" signal, treated
 *     as failure → trigger fallback.
 *   - Cost cap per call is enforced upstream by the HTTP route's
 *     BudgetTracker check. This module reports `costUsd` honestly
 *     (sum of primary + fallback when both fired).
 *   - Binary files filtered out by the caller before this function
 *     sees them — we can't merge binary content textually.
 */

const CONFLICT_MARKER_RE = /^(<{7}\s|={7}$|>{7}\s)/m;
/** Cap on per-call cost. The HTTP route does workspace-wide budget
 *  enforcement before this fires; this is just defence-in-depth so
 *  a runaway model invocation can't burn unbounded $. Applied per
 *  file — total caller-visible cost is multiplied by file count. */
export const MAX_PER_FILE_COST_USD = 0.5;

export interface MergeResolverFile {
  /** Path relative to repo root, e.g. `src/game.js`. */
  path: string;
  /** Target-branch (HEAD) content. */
  ours: string;
  /** Incoming (worktree branch) content. */
  theirs: string;
  /** Conflict-marked working-tree content. */
  merged: string;
}

export interface TicketContext {
  /** Ticket title — agent sees this to understand intent. */
  title: string;
  /** First N chars of ticket body for context. */
  bodyExcerpt: string;
}

export interface MergeResolveBranches {
  /** Name of the target branch (`main` / `master`). Surfaced to
   *  the model as "ours". */
  targetBranch: string;
  /** Name of the worktree branch (`auto-XXX`). Surfaced as
   *  "theirs". */
  worktreeBranch: string;
}

export interface ResolveFileSuccess {
  readonly ok: true;
  readonly path: string;
  readonly content: string;
  /** Which model produced the accepted output. */
  readonly modelUsed: 'primary' | 'fallback';
  readonly costUsd: number;
}

export interface ResolveFileFailure {
  readonly ok: false;
  readonly path: string;
  readonly reason:
    | 'primary_threw'
    | 'fallback_threw'
    | 'primary_markers_only'
    | 'fallback_markers_only'
    | 'budget_exceeded';
  readonly message: string;
  /** Cost we still paid even though the result was rejected. */
  readonly costUsd: number;
}

export type ResolveFileResult = ResolveFileSuccess | ResolveFileFailure;

export interface ResolveBatchResult {
  readonly results: readonly ResolveFileResult[];
  /** Sum of all cost across all files + retries. */
  readonly totalCostUsd: number;
  readonly okCount: number;
  readonly failedCount: number;
  /** Whether at least one file's resolution required the fallback
   *  model (primary failed). UI surfaces this so the user knows
   *  fallback fired. */
  readonly anyFallback: boolean;
}

export interface ResolveBatchArgs {
  provider: LLMProvider;
  primaryModel: string;
  /** Empty string → single-attempt mode (no retry on primary
   *  failure). */
  fallbackModel: string;
  files: readonly MergeResolverFile[];
  ticketContext: TicketContext;
  branches: MergeResolveBranches;
}

/** Resolve all conflicts in the batch. Per-file parallel calls;
 *  the result preserves input order. */
export async function resolveConflictsWithAI(
  args: ResolveBatchArgs,
): Promise<ResolveBatchResult> {
  const results = await Promise.all(
    args.files.map((f) =>
      resolveOneFile({
        provider: args.provider,
        primaryModel: args.primaryModel,
        fallbackModel: args.fallbackModel,
        file: f,
        ticketContext: args.ticketContext,
        branches: args.branches,
      }),
    ),
  );
  let total = 0;
  let okCount = 0;
  let failedCount = 0;
  let anyFallback = false;
  for (const r of results) {
    total += r.costUsd;
    if (r.ok) {
      okCount++;
      if (r.modelUsed === 'fallback') anyFallback = true;
    } else {
      failedCount++;
    }
  }
  return {
    results,
    totalCostUsd: total,
    okCount,
    failedCount,
    anyFallback,
  };
}

interface ResolveOneArgs {
  provider: LLMProvider;
  primaryModel: string;
  fallbackModel: string;
  file: MergeResolverFile;
  ticketContext: TicketContext;
  branches: MergeResolveBranches;
}

async function resolveOneFile(args: ResolveOneArgs): Promise<ResolveFileResult> {
  const prompt = buildResolvePrompt(args.file, args.ticketContext, args.branches);

  let primaryCost = 0;
  let primaryError: string | null = null;
  let primaryRejected = false;

  // Primary attempt.
  try {
    const resp = await args.provider.complete({
      model: args.primaryModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    });
    primaryCost = resp.costUsd;
    if (primaryCost > MAX_PER_FILE_COST_USD) {
      return {
        ok: false,
        path: args.file.path,
        reason: 'budget_exceeded',
        message: `Primary model cost $${primaryCost.toFixed(4)} > per-file cap $${MAX_PER_FILE_COST_USD.toFixed(2)}.`,
        costUsd: primaryCost,
      };
    }
    const cleaned = stripFences(resp.content);
    if (!CONFLICT_MARKER_RE.test(cleaned)) {
      return {
        ok: true,
        path: args.file.path,
        content: cleaned,
        modelUsed: 'primary',
        costUsd: primaryCost,
      };
    }
    primaryRejected = true;
    primaryError = 'Primary returned content with leftover conflict markers.';
  } catch (err) {
    primaryError = (err as Error).message?.slice(0, 200) ?? String(err);
  }

  // Fall through to fallback if configured.
  if (!args.fallbackModel || args.fallbackModel === args.primaryModel) {
    return {
      ok: false,
      path: args.file.path,
      reason: primaryRejected ? 'primary_markers_only' : 'primary_threw',
      message: primaryError ?? 'unknown primary failure',
      costUsd: primaryCost,
    };
  }

  let fallbackCost = 0;
  try {
    const resp = await args.provider.complete({
      model: args.fallbackModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    });
    fallbackCost = resp.costUsd;
    const totalCost = primaryCost + fallbackCost;
    if (fallbackCost > MAX_PER_FILE_COST_USD) {
      return {
        ok: false,
        path: args.file.path,
        reason: 'budget_exceeded',
        message: `Fallback model cost $${fallbackCost.toFixed(4)} > per-file cap $${MAX_PER_FILE_COST_USD.toFixed(2)}.`,
        costUsd: totalCost,
      };
    }
    const cleaned = stripFences(resp.content);
    if (!CONFLICT_MARKER_RE.test(cleaned)) {
      return {
        ok: true,
        path: args.file.path,
        content: cleaned,
        modelUsed: 'fallback',
        costUsd: totalCost,
      };
    }
    return {
      ok: false,
      path: args.file.path,
      reason: 'fallback_markers_only',
      message: 'Both primary AND fallback returned content with leftover conflict markers.',
      costUsd: totalCost,
    };
  } catch (err) {
    const fallbackErr = (err as Error).message?.slice(0, 200) ?? String(err);
    return {
      ok: false,
      path: args.file.path,
      reason: 'fallback_threw',
      message: `${fallbackErr} (after primary: ${primaryError ?? 'n/a'})`,
      costUsd: primaryCost + fallbackCost,
    };
  }
}

// ---------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior software engineer resolving a git merge conflict for an auto-code workflow.

You will be given:
- A ticket description (title + body excerpt) that explains what the auto-code branch was meant to do.
- The "ours" version of a file (HEAD, the target branch).
- The "theirs" version of a file (the auto-code worktree branch).
- The conflict-marked working-tree content git produced when it tried to auto-merge.

Resolve the conflict. Preserve both sides' intent where possible:
- If the changes are independent (different lines / functions / blocks) — keep both.
- If the changes overlap (same logic, different implementation) — pick the version that better matches the ticket's intent + preserve the other side's tests / comments / type signatures when they don't conflict.
- If unclear — prefer the "ours" (HEAD) side since it's already on trunk.

Output ONLY the resolved file content. No commentary. No conflict markers (<<<<<<<, =======, >>>>>>>). No triple-backtick fences. Plain file content as it should appear on disk after \`git add\`.`;

function buildResolvePrompt(
  file: MergeResolverFile,
  ticket: TicketContext,
  branches: MergeResolveBranches,
): string {
  // Cap each side at a generous budget to keep token usage bounded.
  // 60 KB / side covers ~95% of real merge conflicts; bigger files
  // are usually generated / vendored and shouldn't be auto-resolved.
  const cap = 60 * 1024;
  const ours = truncatePreservingEnds(file.ours, cap);
  const theirs = truncatePreservingEnds(file.theirs, cap);
  const merged = truncatePreservingEnds(file.merged, cap * 2);
  return [
    `## Ticket`,
    `Title: ${ticket.title}`,
    ``,
    `Body excerpt:`,
    ticket.bodyExcerpt || '(no body)',
    ``,
    `## Branches`,
    `"ours" (HEAD, target branch): ${branches.targetBranch}`,
    `"theirs" (incoming, worktree branch): ${branches.worktreeBranch}`,
    ``,
    `## File: ${file.path}`,
    ``,
    `### Ours (HEAD content)`,
    '```',
    ours,
    '```',
    ``,
    `### Theirs (incoming content)`,
    '```',
    theirs,
    '```',
    ``,
    `### Conflict-marked working-tree content (what git wrote)`,
    '```',
    merged,
    '```',
    ``,
    `Output the resolved \`${file.path}\` content below. Plain file body. No conflict markers. No commentary.`,
  ].join('\n');
}

// ---------------------------------------------------------------------
// Output sanitization
// ---------------------------------------------------------------------

/** Strip optional ```language fence wrapping that some models add
 *  despite the instruction. Also strip a leading "Here is the
 *  resolved content:" line if present. */
export function stripFences(raw: string): string {
  let s = raw.trim();
  // Strip leading commentary line.
  const lines = s.split('\n');
  if (
    lines.length > 1 &&
    /^(here'?s?|here is|below is|resolved|the resolved)/i.test(lines[0]!)
  ) {
    s = lines.slice(1).join('\n').trim();
  }
  // Strip triple-backtick fence (optionally with language).
  const fenceStart = /^```[a-zA-Z0-9_-]*\n/;
  const fenceEnd = /\n```\s*$/;
  if (fenceStart.test(s) && fenceEnd.test(s)) {
    s = s.replace(fenceStart, '').replace(fenceEnd, '');
  }
  return s;
}

function truncatePreservingEnds(content: string, cap: number): string {
  if (content.length <= cap) return content;
  const head = content.slice(0, cap / 2);
  const tail = content.slice(content.length - cap / 2);
  return `${head}\n\n... [truncated ${content.length - cap} chars] ...\n\n${tail}`;
}
