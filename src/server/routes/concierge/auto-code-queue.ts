/**
 * Auto-code transcript surface for AutoCodeDrawer (sub-ticket
 * 01KQEEDPHX13B92BXKH8G3M9EG).
 *
 * - GET /api/auto-code/queue/:id/sessions          — list every session
 *     produced by this run (cli_agent + human_gate + mo_stage).
 * - GET /api/auto-code/queue/:id/transcript        — snapshot of the
 *     resolved session's transcript (legacy claude JSONL OR new harness
 *     JSONL — chosen by row engine).
 * - GET /api/auto-code/queue/:id/transcript/stream — SSE stream of
 *     transcript updates with 15s heartbeat; closes on terminal state.
 *
 * Stage-resolution precedence on `transcript` + `transcript/stream`:
 *   1. `?stageRowId=<row-ulid>` — exact stage row (handles reopen
 *      retries — same stageIdInGraph attempted N times).
 *   2. `?stageId=<id>`          — most-recent attempt with that graph
 *      stage id (handles "show me latest of stage X").
 *   3. legacy `?session=fix|review` — 1st / 2nd cli_agent stage in the
 *      run (back-compat with the original drawer Tabs).
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 10/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AgentQueueRepository } from '../../../core/auto-code/queue.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import {
  parseTranscriptFile,
  parseHarnessTranscriptFile,
  transcriptPath,
  watchTranscript,
} from '../../../core/auto-code/transcript-reader.js';
import type { ToolContext } from '../../tools/types.js';

export function registerAutoCodeQueueRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // ------- Auto-code transcript reader (sub-ticket 01KQEEDPHX13B92BXKH8G3M9EG) -
  // Powers the AutoCodeDrawer in the UI so the user can see what the
  // headless `claude -p` session is doing in real time. Queue row
  // carries repoPath + worktreeName + fixSessionId + reviewSessionId
  // — enough to resolve the on-disk JSONL transcript at
  // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
  //
  // Pro-gated to match the rest of the auto-code surface — Free
  // users can't enable auto-code so they can't have transcripts.
  /**
   * Phase 5 follow-up — list every session this run produced so the
   * drawer's session selector can replace the hardcoded fix/review
   * tabs. Workflows are no longer linear claude→codex; a v2 DAG can
   * run multiple cli_agent stages (planning → fix → review), Mo
   * decision stages (mo_start, mo_after_fix, mo_after_review,
   * mo_tools — each tracked even though most produce no transcript
   * file), and human_gate pauses (each gets a linked Ask Mo session
   * id in the stage output).
   *
   * Response shape: `{sessions: [{stageId, stageKind, agentName,
   * sessionId, status, attempt, label}]}` ordered oldest-first by
   * stage row id (ULID monotonic → matches dispatch order).
   *
   * For legacy `mo_agent_queue` rows there are only ever fix +
   * review; preserve those labels for back-compat with the visual
   * surface.
   */
  app.get('/api/auto-code/queue/:id/sessions', (c) => {
    const rowId = c.req.param('id');
    const agentQueue = new AgentQueueRepository(ctx.db);
    const legacyRow = agentQueue.getById(rowId);
    if (legacyRow) {
      const sessions: Array<{
        stageId: string;
        stageKind: string;
        agentName: string | null;
        sessionId: string;
        status: string;
        attempt: number;
        label: string;
        engine: 'legacy';
      }> = [];
      if (legacyRow.fixSessionId) {
        sessions.push({
          stageId: 'fix',
          stageKind: 'cli_agent',
          agentName: 'claude',
          sessionId: legacyRow.fixSessionId,
          status: legacyRow.state,
          attempt: legacyRow.attempts ?? 1,
          label: 'Fix session',
          engine: 'legacy',
        });
      }
      if (legacyRow.reviewSessionId) {
        sessions.push({
          stageId: 'review',
          stageKind: 'cli_agent',
          agentName: 'codex',
          sessionId: legacyRow.reviewSessionId,
          status: legacyRow.state,
          attempt: 1,
          label: 'Review session',
          engine: 'legacy',
        });
      }
      return c.json({ sessions });
    }
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const wfRun = wfRepo.getRun(rowId);
    if (!wfRun) return c.json({ error: 'queue_row_not_found' }, 404);
    // List every stage row that produced a session id. cli_agent
    // stages always do; human_gate stages do (the linked concierge
    // session id from `pauseForHumanGate`); mo_stage decisions
    // generally don't (Mo's chat-tier LLM call lives in the
    // concierge bag, not the stage). We surface all kinds so the
    // dropdown can render a label per stage even when there's no
    // transcript yet.
    const stageRows = wfRepo
      .listStagesForRun(wfRun.id)
      .filter((s) => s.sessionId !== null);
    // Build labels — cli_agent uses the stage id + agent name
    // ("fix · claude" vs "review · codex"). human_gate uses
    // "stageId — chat". mo_stage uses "stageId — Mo decision".
    const sessions = stageRows.map((s, idx) => {
      let label: string;
      if (s.stageKind === 'cli_agent') {
        label = s.agentName
          ? `${s.stageIdInGraph} · ${s.agentName}`
          : s.stageIdInGraph;
      } else if (s.stageKind === 'human_gate') {
        label = `${s.stageIdInGraph} — chat`;
      } else {
        label = `${s.stageIdInGraph} — ${s.stageKind}`;
      }
      // Disambiguate retries (reopen loop) by appending attempt #
      // when the stage has been retried.
      if (s.attempt > 1) label += ` (attempt ${s.attempt})`;
      // Re-running gives the same stageIdInGraph; the drawer ui
      // keys by stage-row.id to keep them distinct.
      void idx;
      return {
        rowId: s.id,
        stageId: s.stageIdInGraph,
        stageKind: s.stageKind,
        agentName: s.agentName,
        sessionId: s.sessionId!,
        status: s.status,
        attempt: s.attempt,
        label,
        engine: 'workflow' as const,
      };
    });
    return c.json({ sessions });
  });

  app.get('/api/auto-code/queue/:id/transcript', async (c) => {
    const rowId = c.req.param('id');
    const session = c.req.query('session') === 'review' ? 'review' : 'fix';
    // Phase 5 follow-up — new explicit `?stageId=<id>` param targets
    // a specific workflow stage's session. Used by the drawer's
    // SessionSelector dropdown so the user can scrub through any
    // stage's transcript, not just fix/review. Empty / unset → fall
    // back to legacy fix/review picking (1st cli_agent / 2nd
    // cli_agent in the run's stage list).
    //
    // Optional companion `?stageRowId=<row-ulid>` disambiguates
    // repeated visits of the same stage (reopen-loop). When set,
    // takes precedence over stageId.
    const explicitStageRowId = c.req.query('stageRowId') || null;
    const explicitStageId = c.req.query('stageId') || null;
    const agentQueue = new AgentQueueRepository(ctx.db);
    const legacyRow = agentQueue.getById(rowId);
    if (legacyRow) {
      // Legacy `mo_agent_queue` row — original transcript path via
      // Claude's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
      // Legacy only ever has fix + review; new `stageId` shape is a
      // pass-through to the same picker.
      const effectiveSession =
        explicitStageId === 'review' || session === 'review' ? 'review' : 'fix';
      const sessionId = effectiveSession === 'review' ? legacyRow.reviewSessionId : legacyRow.fixSessionId;
      if (!sessionId) {
        return c.json({ messages: [], warnings: [`no ${effectiveSession} session id on queue row yet`] });
      }
      if (!legacyRow.worktreeName) {
        return c.json({ messages: [], warnings: ['queue row has no worktree yet'] });
      }
      const path = transcriptPath(legacyRow.repoPath, legacyRow.worktreeName, sessionId);
      if (!path) {
        return c.json({ messages: [], warnings: ['could not resolve transcript path'] });
      }
      const result = await parseTranscriptFile(path);
      return c.json({ ...result, sessionId, transcriptPath: path });
    }

    // No legacy row → try `workflow_runs`. Phase 4.5 routing flip
    // means all new auto-code runs land in this table; without this
    // fallback the drawer 404'd on every workflow-engine ticket.
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const wfRun = wfRepo.getRun(rowId);
    if (!wfRun) return c.json({ error: 'queue_row_not_found' }, 404);
    const allStages = wfRepo.listStagesForRun(wfRun.id);
    // Stage resolution order:
    //   1. `stageRowId` → exact stage row (handles reopen retries).
    //   2. `stageId` → most-recent attempt with that graph stage id.
    //   3. legacy `session=fix|review` → 1st / 2nd cli_agent stage
    //      (back-compat with the original drawer Tabs).
    let stage = (() => {
      if (explicitStageRowId) {
        return allStages.find((s) => s.id === explicitStageRowId) ?? null;
      }
      if (explicitStageId) {
        const matches = allStages
          .filter((s) => s.stageIdInGraph === explicitStageId && s.sessionId !== null)
          .sort((a, b) => b.attempt - a.attempt);
        return matches[0] ?? null;
      }
      const cliStages = allStages.filter(
        (s) => s.stageKind === 'cli_agent' && s.sessionId !== null,
      );
      return (session === 'review' ? cliStages[1] : cliStages[0]) ?? null;
    })();
    if (session === 'review' && !stage && !explicitStageId && !explicitStageRowId) {
      const cliCount = allStages.filter((s) => s.stageKind === 'cli_agent' && s.sessionId !== null).length;
      if (cliCount < 2) {
        return c.json({
          messages: [],
          warnings: ['this workflow does not have a review stage'],
        });
      }
    }
    if (!stage || !stage.sessionId) {
      return c.json({
        messages: [],
        warnings: [`no session on this run yet${explicitStageId ? ` for stage \`${explicitStageId}\`` : ''}`],
      });
    }
    // Workflow runs persist transcripts under `~/.morion/runs/<sessionId>.jsonl`
    // — set in `auto-code-factory.ts` via `transcriptDir = ~/.morion/runs`.
    // The harness JSONL shape differs from Claude's projects format,
    // so use the dedicated parser.
    const wfPath =
      stage.transcriptPath ??
      `${process.env.HOME ?? ''}/.morion/runs/${stage.sessionId}.jsonl`;
    const result = await parseHarnessTranscriptFile(wfPath);
    return c.json({
      ...result,
      sessionId: stage.sessionId,
      transcriptPath: wfPath,
    });
  });

  app.get('/api/auto-code/queue/:id/transcript/stream', (c) => {
    const rowId = c.req.param('id');
    const session = c.req.query('session') === 'review' ? 'review' : 'fix';
    // Same stageId / stageRowId resolution as the snapshot route.
    const explicitStageRowId = c.req.query('stageRowId') || null;
    const explicitStageId = c.req.query('stageId') || null;
    const agentQueue = new AgentQueueRepository(ctx.db);
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    // Resolve the right path + isTerminal probe regardless of which
    // engine (legacy mo_agent_queue vs workflow_runs) owns the row.
    interface StreamCtx {
      path: string;
      sessionId: string;
      parser: 'claude' | 'harness';
      isTerminal: () => boolean;
    }
    let streamCtx: StreamCtx | null = null;
    const legacyRow = agentQueue.getById(rowId);
    if (legacyRow) {
      const sessionId =
        session === 'review' ? legacyRow.reviewSessionId : legacyRow.fixSessionId;
      if (!sessionId || !legacyRow.worktreeName) {
        return c.json({ error: 'session_not_started' }, 409);
      }
      const path = transcriptPath(
        legacyRow.repoPath,
        legacyRow.worktreeName,
        sessionId,
      );
      if (!path) return c.json({ error: 'transcript_path_unresolvable' }, 500);
      streamCtx = {
        path,
        sessionId,
        parser: 'claude',
        isTerminal: () => {
          const fresh = agentQueue.getById(rowId);
          return (
            !fresh || ['done', 'failed', 'cancelled'].includes(fresh.state)
          );
        },
      };
    } else {
      const wfRun = wfRepo.getRun(rowId);
      if (!wfRun) return c.json({ error: 'queue_row_not_found' }, 404);
      const allStages = wfRepo.listStagesForRun(wfRun.id);
      const stage = (() => {
        if (explicitStageRowId) {
          return allStages.find((s) => s.id === explicitStageRowId) ?? null;
        }
        if (explicitStageId) {
          const matches = allStages
            .filter((s) => s.stageIdInGraph === explicitStageId && s.sessionId !== null)
            .sort((a, b) => b.attempt - a.attempt);
          return matches[0] ?? null;
        }
        const cliStages = allStages.filter(
          (s) => s.stageKind === 'cli_agent' && s.sessionId !== null,
        );
        return (session === 'review' ? cliStages[1] : cliStages[0]) ?? null;
      })();
      if (!stage || !stage.sessionId) {
        return c.json({ error: 'session_not_started' }, 409);
      }
      const path =
        stage.transcriptPath ??
        `${process.env.HOME ?? ''}/.morion/runs/${stage.sessionId}.jsonl`;
      streamCtx = {
        path,
        sessionId: stage.sessionId,
        parser: 'harness',
        isTerminal: () => {
          const fresh = wfRepo.getRun(rowId);
          return (
            !fresh || ['done', 'failed', 'cancelled'].includes(fresh.status)
          );
        },
      };
    }
    const { path, sessionId, parser, isTerminal } = streamCtx;
    return streamSSE(c, async (sse) => {
      // Caller-side abort plumbed via Promise — fs.watch handle
      // closes when sse.close() runs in the finally.
      let resolve!: () => void;
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const handle = watchTranscript(
        path,
        (result) => {
          void sse.writeSSE({
            event: 'transcript',
            data: JSON.stringify({ ...result, sessionId }),
          });
          if (isTerminal()) resolve();
        },
        { debounceMs: 250, parser },
      );
      try {
        // Heartbeat every 15s so reverse proxies (and the browser's
        // EventSource ping logic) don't time out a quiet stream.
        const heartbeat = setInterval(() => {
          void sse.writeSSE({ event: 'ping', data: String(Date.now()) });
        }, 15_000);
        try {
          await done;
        } finally {
          clearInterval(heartbeat);
        }
      } finally {
        handle.stop();
      }
    });
  });
}
