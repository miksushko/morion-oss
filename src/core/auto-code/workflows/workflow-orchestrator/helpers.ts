/**
 * Workflow orchestrator — pure helpers.
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. No `this` state, no class membership. Two flavours:
 *
 *   - Inspection helpers over WorkflowDefinition (describeAgentChain,
 *     stageDescriptor, findReopenTargetStageId, collectRequiredAgents)
 *   - String / git shell utilities (capitalise, formatActor, snippet,
 *     sanitiseBranchName, execGit) and the default worktree life-cycle
 *     funcs (defaultEnsureWorktree, defaultCleanupWorktree).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { WorkflowDefinition } from '../types/index.js';
import type { EnsureWorktreeArgs } from './types.js';
import { withRepoGitLock } from './repo-git-lock.js';

/** Build a human-readable summary of the cli_agent chain for Mo
 *  comments — e.g. `claude (fix) → codex (review)`. Non-cli stages
 *  show only their id (none ship in L2 today; future-proofing for
 *  L3/L4). */
export function describeAgentChain(def: WorkflowDefinition): string {
  return def.stages.map((s) => stageDescriptor(s)).join(' → ');
}

export function stageDescriptor(stage: WorkflowDefinition['stages'][number]): string {
  if (stage.kind === 'cli_agent') {
    return `${stage.agent} (${stage.id})`;
  }
  return stage.id;
}

export function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Find the stage id the reopen verdict targets. For the legacy
 * linear workflow this is always the FIRST cli_agent stage with a
 * verdictPolicy set (the "fix" stage). Future workflows can override
 * via an explicit reopen-target field. Returns null when no stage
 * has verdict policy — single-stage templates.
 */
export function findReopenTargetStageId(def: WorkflowDefinition): string | null {
  for (const s of def.stages) {
    if (s.kind === 'cli_agent' && s.verdictPolicy) {
      // The verdict policy itself names the stage to reopen TO.
      if (s.verdictPolicy.onReopen?.reopenStageId) {
        return s.verdictPolicy.onReopen.reopenStageId;
      }
    }
  }
  return null;
}

/**
 * Walk the workflow's stages and collect every agent name listed
 * in cli_agent stages. Used by the orchestrator's required-agents
 * preflight (Codex P2, 2026-05-10) to fail enqueue cleanly when
 * the template needs an agent that's not installed.
 */
export function collectRequiredAgents(def: WorkflowDefinition): readonly string[] {
  const required = new Set<string>();
  const optional = new Set<string>();
  // Mirror `splitAgents` in templates.ts: a stage WITH a fallback
  // makes its PRIMARY optional (the run can complete on the fallback)
  // and the FALLBACK required. A stage WITHOUT a fallback makes its
  // primary required. The old code had this inverted — it marked the
  // primary required and the fallback optional, so a folder on the
  // default template (codex review + claude fallback) was rejected
  // with `agent_unavailable` on any machine without a sidecar-
  // detectable codex, defeating the whole point of the fallback.
  for (const s of def.stages) {
    if (s.kind !== 'cli_agent') continue;
    if (s.fallbackAgent) {
      optional.add(s.agent);
      required.add(s.fallbackAgent);
    } else {
      required.add(s.agent);
    }
  }
  // A primary that's required by some other (fallback-less) stage
  // outranks its optional status here.
  for (const r of required) optional.delete(r);
  return Array.from(required);
}

export function formatActor(actor: string): string {
  if (actor === 'mcp:auto-code') return 'Mo';
  if (actor.startsWith('mcp:')) return actor.slice(4);
  return actor;
}

/**
 * Default `ensureWorktree` impl. Runs `git worktree add <path> -b <branch>`
 * inside `repoPath`. No-op when the path already exists (resume / dedupe
 * path). Tests override with a synthetic fn.
 */
export async function defaultEnsureWorktree(args: EnsureWorktreeArgs): Promise<void> {
  if (existsSync(args.worktreePath)) return;
  const branch = sanitiseBranchName(args.worktreeName);
  // Serialise `worktree add` per repo — concurrent enqueues (N tickets
  // dragged to todo at once) otherwise race on the shared `.git` admin
  // area and a loser fails with a lock error. See repo-git-lock.ts.
  await withRepoGitLock(args.repoPath, () =>
    execGit(args.repoPath, ['worktree', 'add', args.worktreePath, '-b', branch]),
  );
}

/**
 * Default `cleanupWorktree` impl — best-effort `git worktree remove
 * --force <path>`. No-op when the path doesn't exist (already gone).
 */
export async function defaultCleanupWorktree(args: EnsureWorktreeArgs): Promise<void> {
  if (!existsSync(args.worktreePath)) return;
  try {
    // Same per-repo lock as `worktree add` — remove mutates the same
    // `.git` admin area and must not race a concurrent add/remove.
    await withRepoGitLock(args.repoPath, () =>
      execGit(args.repoPath, [
        'worktree',
        'remove',
        '--force',
        args.worktreePath,
      ]),
    );
  } catch {
    // Best-effort; orphan sweep on next startup picks up stragglers.
  }
}

/** Branch names can't contain spaces or some special chars. Strip
 *  anything outside `[A-Za-z0-9_/.-]` (git's allowed set) so a user-
 *  named worktree doesn't blow up `git worktree add`. */
export function sanitiseBranchName(name: string): string {
  const stripped = name.replace(/[^A-Za-z0-9_/.-]+/g, '-');
  return stripped.replace(/^[-./]+/, '') || 'autocode';
}

export function execGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr}`));
    });
  });
}

/** Truncate `text` to `maxChars` and append an ellipsis marker. */
export function snippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…(truncated)';
}
