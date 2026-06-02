/**
 * Auto-code scheduler wiring. MASTER ONLY — excluded from the public OSS
 * export (scripts/export-public.mjs EXCLUDE list). In the public build,
 * `index.public.ts` (exporting `null`, swapped to index.ts at export)
 * takes over so `bootstrap/start.ts` starts the Concierge scheduler with
 * Mo-indexing + topic-hygiene only, no auto-code ticks.
 *
 * This module owns everything `start.ts` used to inline for auto-code:
 *   1. Stale-run recovery — heal workflow_runs left pending/running by a
 *      crashed prior sidecar.
 *   2. Orphan-worktree sweep — fire-and-forget cleanup of abandoned
 *      `auto-<ulid>` git worktrees.
 *   3. The two scheduler tick callbacks (enqueue tick + startup sweep).
 *
 * `start.ts` calls these through the optional `autoCodeSchedulerWiring`
 * binding so the composer file ships byte-identical to both repos.
 */
import type { Runtime } from '../../../core/runtime.js';
import { buildAutoCodeDispatcher } from '../auto-code-factory/index.js';
import {
  runAutoCodeEnqueueTick,
  runAutoCodeStartupSweep,
} from '../auto-code-tick/index.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import type {
  AutoCodeSchedulerHooks,
  AutoCodeSchedulerWiring,
} from './types.js';

export type { AutoCodeSchedulerHooks, AutoCodeSchedulerWiring } from './types.js';

export const autoCodeSchedulerWiring: AutoCodeSchedulerWiring = {
  recoverStaleRuns(rt: Runtime): void {
    const runsRepo = new WorkflowRunsRepository(rt.handle.db);
    const orphans = runsRepo.listActiveRuns();
    if (orphans.length > 0) {
      const now = Date.now();
      for (const run of orphans) {
        // Mark every non-terminal stage row too.
        for (const stage of runsRepo.listStagesForRun(run.id)) {
          if (stage.status === 'pending' || stage.status === 'running') {
            runsRepo.updateStage(
              stage.id,
              {
                status: 'failed',
                activePid: null,
                lastError: 'interrupted_by_restart',
                finishedAt: now,
              },
              now,
            );
          }
        }
        runsRepo.updateRun(
          run.id,
          {
            status: 'failed',
            currentStageId: null,
            lastError: 'interrupted_by_restart',
            finishedAt: now,
          },
          now,
        );
      }
      console.log(
        `  scheduler: recovered ${orphans.length} stale workflow_run(s) left by prior sidecar`,
      );
    }
  },

  sweepOrphanWorktrees(rt: Runtime): void {
    void (async () => {
      try {
        const runsRepo = new WorkflowRunsRepository(rt.handle.db);
        const folderSettings = rt.concierge?.folderSettings;
        if (!folderSettings) return;
        const { listOrphanWorktrees } = await import(
          '../../../core/auto-code/worktree-paths.js'
        );
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execGit = promisify(execFile);
        const enabledFolders = folderSettings.listEnabled();
        let totalRemoved = 0;
        for (const f of enabledFolders) {
          if (!f.linkedRepoPath) continue;
          // Active = anything not safely deletable. `done` is
          // preserved so the user keeps the Merge-into-main option.
          const activeNames = new Set<string>();
          // workflow_runs: keep pending/running/paused + DONE (not merged)
          for (const r of runsRepo.listActiveRuns()) {
            if (r.folderId === f.folderId && r.worktreePath) {
              const name = r.worktreePath.split('/').pop();
              if (name) activeNames.add(name);
            }
          }
          // Also preserve done-but-not-merged rows so the user can
          // still click Merge from the drawer.
          const allRunsForFolder = rt.handle.db
            .prepare<[string], { worktree_path: string; status: string; merged_at: number | null }>(
              `SELECT worktree_path, status, merged_at FROM workflow_runs WHERE folder_id = ?`,
            )
            .all(f.folderId);
          for (const r of allRunsForFolder) {
            if (r.status === 'done' && r.merged_at === null) {
              const name = r.worktree_path.split('/').pop();
              if (name) activeNames.add(name);
            }
          }
          // Legacy mo_agent_queue parallel.
          try {
            const legacyRows = rt.handle.db
              .prepare<[string], { worktree_name: string | null; state: string }>(
                `SELECT worktree_name, state FROM mo_agent_queue WHERE folder_id = ?`,
              )
              .all(f.folderId);
            for (const r of legacyRows) {
              if (!r.worktree_name) continue;
              if (
                r.state === 'pending' ||
                r.state === 'fix_running' ||
                r.state === 'fix_review' ||
                r.state === 'review_running' ||
                r.state === 'reopened' ||
                r.state === 'done'
              ) {
                activeNames.add(r.worktree_name);
              }
            }
          } catch {
            // mo_agent_queue table might not exist (fresh install
            // or future deletion). Silent.
          }
          const orphans = await listOrphanWorktrees(
            f.linkedRepoPath,
            activeNames,
          );
          for (const name of orphans) {
            // Probe both new + legacy locations.
            const candidates = [
              `${f.linkedRepoPath}/.morion/worktrees/${name}`,
              `${f.linkedRepoPath}/.claude/worktrees/${name}`,
            ];
            for (const p of candidates) {
              try {
                await execGit(
                  'git',
                  ['-C', f.linkedRepoPath, 'worktree', 'remove', '--force', p],
                  { timeout: 30_000 },
                );
                totalRemoved += 1;
                break; // either was the right path
              } catch {
                // Try next candidate; final failure is silent.
              }
            }
          }
          // One prune per folder so the git ref-list reflects reality.
          try {
            await execGit(
              'git',
              ['-C', f.linkedRepoPath, 'worktree', 'prune'],
              { timeout: 10_000 },
            );
          } catch {
            /* best-effort */
          }
        }
        if (totalRemoved > 0) {
          console.log(
            `  orphan-worktree sweep: removed ${totalRemoved} stale auto-code worktree(s)`,
          );
        }
      } catch (err) {
        console.warn(
          '[orphan-worktree-sweep] threw, ignoring:',
          (err as Error).message ?? String(err),
        );
      }
    })();
  },

  buildSchedulerHooks(rt: Runtime, configDir: string): AutoCodeSchedulerHooks {
    // Build a ToolContext for the dispatcher factory. The dispatcher
    // needs db / notes / folders / comments / audit / settings /
    // concierge — all available on `rt`. We mint a fresh object per
    // dispatcher call so future config changes (engine flag flip,
    // settings updates) take effect on the next tick.
    const buildToolCtx = () =>
      ({
        db: rt.handle.db,
        notes: rt.notes,
        folders: rt.folders,
        tags: rt.tags,
        revisions: rt.revisions,
        attachments: rt.attachments,
        comments: rt.comments,
        search: rt.search,
        indexer: rt.indexer,
        embeddings: rt.embeddings,
        audit: rt.audit,
        settings: rt.settings,
        concierge: rt.concierge,
        actor: 'mcp:auto-code',
        configDir,
      }) as unknown as Parameters<typeof buildAutoCodeDispatcher>[0];

    return {
      // Auto-code enqueue tick (T7.B.2.d) — incremental drain of
      // audit_log status_change → todo rows. Catches every trigger
      // path (drag, programmatic, create-with-status) the legacy
      // kanban-move HTTP route missed.
      runAutoCodeEnqueueTick: async () => {
        await runAutoCodeEnqueueTick({
          db: rt.handle.db,
          workspaceSettings: rt.settings,
          comments: rt.comments,
          buildDispatcher: () => buildAutoCodeDispatcher(buildToolCtx()),
        });
      },
      // One-shot startup sweep — picks up tickets that were in `todo`
      // BEFORE the engine started watching the audit log.
      runAutoCodeStartupSweep: async () => {
        await runAutoCodeStartupSweep({
          db: rt.handle.db,
          workspaceSettings: rt.settings,
          comments: rt.comments,
          buildDispatcher: () => buildAutoCodeDispatcher(buildToolCtx()),
        });
      },
    };
  },
};
