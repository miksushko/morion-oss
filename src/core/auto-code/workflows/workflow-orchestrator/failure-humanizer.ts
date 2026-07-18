/**
 * Translate runner sentinel `lastError` strings into plain-language
 * sentences for the user-facing ticket comment posted by
 * `onRunTerminal` on a `failed` run.
 *
 * Cryptic sentinels surfaced as-is (`interrupted_by_restart`,
 * `mo_provider_unconfigured`, `worktree_setup_failed: …`) left users
 * staring at jargon with no idea what to do — the closing comment
 * said "Auto-code paused. interrupted_by_restart" and that was the
 * end of the trail. User feedback 2026-05-19. Humanizer maps the
 * known sentinels to actionable copy + falls back to a "raw"
 * envelope for unknown strings so the original text isn't lost.
 *
 * Return shape:
 *   - `headline` — first line of the comment ("Auto-code paused: …").
 *   - `detail`   — optional follow-up sentence with the fix.
 *   - `raw`      — the original sentinel, included as a fenced block
 *                  at the end so power users can still grep / file a
 *                  ticket with the exact string.
 */

export interface HumanFailureReason {
  headline: string;
  detail: string | null;
  raw: string;
}

/**
 * Pure mapping — no side effects, no DB access. The hook that calls
 * this owns the comment-post; this just shapes the text.
 *
 * `raw` may be null/empty when the runner didn't set a sentinel
 * (extremely rare — the runner always fills `lastError` on failed
 * status). We surface a generic "ran into an issue" line in that
 * case so the user still gets a comment.
 */
export function humanizeFailureReason(raw: string | null): HumanFailureReason {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return {
      headline: 'Auto-code stopped without a reported reason',
      detail: 'No error string was attached to the run. Re-drag the ticket to `todo` to retry; if it keeps happening, check the sidecar logs.',
      raw: '(no reason given)',
    };
  }

  // Sidecar restarted mid-run (hot-reload during dev, force-quit,
  // OS sleep-wake, manual restart). The agent's worktree is still on
  // disk so partial work is recoverable, but the runner can't resume
  // mid-stage — the user re-drags to retry. Most common failure mode
  // in dev; not a user-error, not a real bug.
  if (trimmed === 'interrupted_by_restart') {
    return {
      headline: 'Auto-code interrupted: the sidecar restarted mid-run',
      detail: 'No partial work is lost — the worktree is still on disk for inspection, but the runner can\'t resume a mid-stage agent. Re-drag the ticket to `todo` to retry from the top.',
      raw: trimmed,
    };
  }

  // Mo stage tried to dispatch but no Mo provider is configured for
  // this workspace. Falls back to LEGACY_LINEAR at the resolver, but
  // any DAG workflow with a mo_stage that ends up here failed because
  // the fallback gate fired AFTER admission.
  if (trimmed === 'mo_provider_unconfigured' || trimmed.startsWith('mo_provider_unconfigured:')) {
    return {
      headline: 'Auto-code stopped: Mo isn\'t configured for this workspace',
      detail: 'The workflow uses Mo decision stages, but no Mo provider (OpenRouter / Groq / Claude / OpenAI / Ollama) is set up. Open **Settings → Mo Agent → API & Provider** to wire one, then re-drag the ticket to `todo`.',
      raw: trimmed,
    };
  }

  // Git worktree creation failed at admission (path conflict, disk
  // full, permission, parent gone). Comes through as
  // `worktree_setup_failed: <git error>` from admission.ts.
  if (trimmed.startsWith('worktree_setup_failed')) {
    const detail = trimmed.split(':').slice(1).join(':').trim();
    return {
      headline: 'Auto-code stopped: couldn\'t create the per-run git worktree',
      detail: `Reason: ${detail || '(no underlying message)'}. Check the linked git repo path in **Folder Settings → Auto-code**, free up disk if it's full, and re-drag.`,
      raw: trimmed,
    };
  }

  // Race condition during admission: user dragged the card out of
  // `todo` (or toggled auto-code off) while the worktree was being
  // set up. Not really a failure — the user's intent took precedence.
  if (trimmed.startsWith('ticket_no_longer_todo')) {
    return {
      headline: 'Auto-code didn\'t start: ticket was moved out of `todo` during setup',
      detail: 'You moved the card before the worktree finished setting up. Drag it back to `todo` if you want to retry.',
      raw: trimmed,
    };
  }
  if (trimmed.startsWith('cancelled_during_admission')) {
    return {
      headline: 'Auto-code cancelled during setup',
      detail: 'Auto-code was toggled off while the run was being set up. Re-enable in **Folder Settings → Auto-code** and re-drag the ticket.',
      raw: trimmed,
    };
  }

  // Workflow shape errors — usually editor-side bugs the user
  // can't fix from kanban. Surface the file name so a debug trail
  // exists.
  if (trimmed.startsWith('resume_misconfigured')) {
    return {
      headline: 'Auto-code stopped: the workflow definition is misconfigured',
      detail: 'The runner couldn\'t resume from where it paused. Edit the workflow in **Folder Settings → Workflows** — most likely the human_gate stage is missing an outbound edge.',
      raw: trimmed,
    };
  }

  // Adapter said the requested cli agent binary isn't on PATH (claude
  // / codex / pi / opencode). Pre-claim gate usually catches this but
  // mid-run binary disappearance hits here.
  if (trimmed.startsWith('agent_unavailable') || trimmed.includes('AgentBinaryNotFoundError') || trimmed.includes('ENOENT')) {
    return {
      headline: 'Auto-code stopped: a required agent binary isn\'t installed',
      detail: 'Check the agent chain in **Folder Settings → Workflows** and install the missing binary (e.g. `npm i -g @anthropic-ai/claude-code` for claude, `brew install pi` for pi). Re-drag the ticket once it\'s on PATH.',
      raw: trimmed,
    };
  }

  // Agent produced no parseable result envelope. The cli adapter
  // emits this when the agent exits without a decodable
  // `--output-format json` envelope (claude) / structured result.
  // Common causes: a malformed or oversized stage instruction (e.g.
  // a whole skill pasted into the stage's Agent Instruction), or the
  // agent isn't authenticated. Must be matched BEFORE the budget
  // branch — the raw text echoes the prompt, which often contains the
  // word "budget" and used to be mislabelled as a budget cap.
  if (trimmed.startsWith('parse_failed')) {
    return {
      headline: 'Auto-code stopped: the agent produced no parseable output',
      detail: 'The cli agent exited without a valid result. Most often the stage instruction is malformed or huge (e.g. a whole skill pasted into the stage\'s Agent Instruction), or the agent isn\'t logged in. Check the stage in **Folder Settings → Workflows** and the agent\'s auth, then re-drag the ticket to `todo`.',
      raw: trimmed,
    };
  }

  // Budget guard fired — Mo or cli_agent stage exhausted its
  // per-stage / workspace cap. Match the SPECIFIC sentinels only,
  // never a bare `includes('budget')`: the raw text frequently
  // carries the word "budget" for unrelated reasons (a prompt echo,
  // a pasted skill mentioning "monthly budget") and the substring
  // match used to shadow the real failure reason.
  if (
    trimmed.startsWith('budget_exhausted') ||
    trimmed.startsWith('budget_guard_denied') ||
    trimmed.startsWith('Mo monthly budget exhausted')
  ) {
    return {
      headline: 'Auto-code stopped: budget cap reached',
      detail: 'Either the per-stage budget set in the workflow OR the workspace-wide Mo / Auto-code monthly cap is exhausted. Bump the cap in **Settings → Limits** or wait for the monthly reset.',
      raw: trimmed,
    };
  }

  // Reopen cap exhausted — the reviewer kept asking the fix stage
  // to redo work, and the workflow's maxAttempts ran out.
  if (trimmed.startsWith('reopen_cap_exhausted')) {
    return {
      headline: 'Auto-code stopped: reviewer kept reopening the fix and the retry cap ran out',
      detail: 'The reviewer found issues on every retry. Read the recent stage comments for what the reviewer wanted, address it manually, and re-drag the ticket.',
      raw: trimmed,
    };
  }

  // Mo stage couldn't pick a branch (verdict JSON parse failed, no
  // matching branch name, model produced gibberish).
  if (trimmed.startsWith('mo_stage_no_verdict') || trimmed.startsWith('mo_stage_invalid_verdict')) {
    return {
      headline: 'Auto-code stopped: a Mo decision stage couldn\'t pick a branch',
      detail: 'Mo\'s reply didn\'t match any of the branch options the workflow expected. This usually means the stage instruction or branch list needs editing in the workflow. Open **Folder Settings → Workflows** to fix.',
      raw: trimmed,
    };
  }

  // Fallback — pass through the raw string but in a sentence shape
  // so the user at least sees "this was the reason" framing instead
  // of bare jargon.
  return {
    headline: 'Auto-code stopped with an error',
    detail: null,
    raw: trimmed,
  };
}

/**
 * Format a `HumanFailureReason` into the markdown body of a closing
 * comment. Format:
 *
 *   Auto-code paused: <headline>
 *
 *   <detail>
 *
 *   Tagged `auto-code-paused`. <action hint>.
 *
 *   ```
 *   <raw>
 *   ```
 *
 * The fenced block at the end is the original sentinel — kept so
 * power users / support can match against grepable error strings.
 */
export function formatFailureComment(reason: HumanFailureReason): string {
  const lines: string[] = [reason.headline];
  if (reason.detail) {
    lines.push('', reason.detail);
  }
  lines.push(
    '',
    'Tagged `auto-code-paused`. Re-drag to `todo` to retry, or fix the underlying issue first.',
    '',
    '```',
    reason.raw,
    '```',
  );
  return lines.join('\n');
}
