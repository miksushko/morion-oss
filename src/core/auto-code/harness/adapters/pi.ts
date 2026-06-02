/**
 * Auto-code CLI Agent Harness — `pi` adapter (L1.T5).
 *
 * Spawns the pi-coding-agent CLI ([pi-mono](https://github.com/badlogic/pi-mono),
 * package `pi`) and translates its `--mode json` LF-JSONL output stream into the
 * unified `CliAgentEvent` stream.
 *
 * ⚠️ **Cost cap NOT enforced.** Pi 0.x doesn't surface per-call cost in its
 * stream — every `result` event reports `costUsd: 0` regardless of the actual
 * provider spend (Ollama is free; OpenRouter / OpenAI cost goes via provider
 * dashboards, not pi). Consequence:
 *   - `SpawnOptions.maxBudgetUsd` is **silently ignored** by this adapter
 *     (pi has no equivalent CLI flag).
 *   - Workflow runner (L2) cannot enforce per-stage budget caps for pi
 *     paid-provider runs from cost-event tracking — `mo_spend_ledger` rows
 *     for `kind='workflow-stage-cli'` will record 0 even when real spend
 *     occurred. UI MUST NOT promise a stage budget for pi paid providers
 *     until pi exposes cost in stream (a future pi-mono enhancement, or
 *     L2 sidecar that reconciles via OpenRouter API). For Ollama-only runs
 *     the limitation is moot (cost = 0 in reality).
 *   - Hard timeouts still enforce via wall-clock (`timeoutMs` works).
 *
 * CLI invocation:
 *
 *     pi -p \
 *       --mode json \
 *       --tools read,write,edit,find,grep,bash \  # mapped from claude-style names
 *       [--provider <prov>] \
 *       [--model <model>] \
 *       [--session <uuid>]                        # for resume
 *       <prompt>
 *
 * Pi `--mode json` output schema (per [docs/json.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md)):
 *   - First line: `{type: 'session', version, id, timestamp, cwd}`
 *   - Lifecycle: `agent_start`, `turn_start`, `message_start`,
 *     `message_update`, `message_end`, `turn_end`, `agent_end`
 *   - Tools: `tool_execution_start`, `tool_execution_update`,
 *     `tool_execution_end`
 *   - Maintenance: `queue_update`, `compaction_*`, `auto_retry_*`
 *
 * Resume: `pi --session <id>` continues an existing session. The
 * adapter overrides `resume(injectedMessage)` to construct a new
 * handle with the resume args.
 *
 * Module layout — per the 2026-05-16 split (Morion ticket
 * 01KRQYSGYJM48WC1NJTTHZ9XNE), kept under the 500-LOC cap per CLAUDE.md
 * and mirroring the `codex/` precedent:
 *   - `./pi/agent-config.ts` — option types + agentConfig narrow +
 *                              tool-name mapping + handle params shape.
 *   - `./pi/event-mappers.ts` — pure `mapPiEventToHarness` + helpers.
 *   - `./pi/handle.ts`        — `PiAgentHandle` state-machine class.
 *   - this file               — `PiAdapter` spawn wiring + public
 *                                re-exports.
 */

import { existsSync } from 'node:fs';

import {
  AgentSpawnError,
  type AgentHandle,
  type CliAgentAdapter,
  type SpawnOptions,
} from '../adapter.js';
import { DEFAULT_TIMEOUT_MS } from '../abstract-handle-types.js';
import type { AgentName } from '../events.js';
import { generateSessionId, resolveAgentBinary } from '../util.js';
import { parseAgentConfig, type PiAdapterOptions } from './pi/agent-config.js';
import { PiAgentHandle } from './pi/handle.js';

// Re-export public surface so existing importers
// (`from '.../adapters/pi.js'`) keep working unchanged.
export { mapPiEventToHarness } from './pi/event-mappers.js';
export type {
  PiAdapterOptions,
  PiAgentConfig,
} from './pi/agent-config.js';

export class PiAdapter implements CliAgentAdapter {
  readonly name: AgentName = 'pi';

  constructor(private readonly options: PiAdapterOptions = {}) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const binPath = await this._resolveBinPath();
    const piConfig = parseAgentConfig(opts.agentConfig);
    // Phase 6 V2 hotfix (2026-05-13) — when caller supplies
    // `resumeSessionId`, spawn in resume mode against that prior
    // pi-authoritative session id. Pi `--session <id>` continues
    // the existing conversation; `prompt` becomes the next user
    // turn injected into it.
    const resumeId = opts.resumeSessionId;
    return PiAgentHandle._start({
      binPath,
      sessionId: resumeId ?? opts.sessionId ?? generateSessionId(),
      agent: 'pi',
      mode: resumeId ? 'resume' : 'fresh',
      prompt: opts.prompt,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      model: opts.model,
      // Workflow Editor v2 `cli_agent.provider` lands as the
      // top-level `opts.provider`. Honour it preferentially over the
      // legacy `agentConfig.provider` narrow path so user intent from
      // the editor reaches the pi CLI flag. Pre-Phase-4 callers
      // (tests, legacy orchestrator pathways) keep their existing
      // `agentConfig.provider` narrowing as a fallback.
      provider: opts.provider ?? piConfig.provider,
      requiredPackages: piConfig.requiredPackages,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: opts.env,
      signal: opts.signal,
      transcriptDir: opts.transcriptDir,
    });
  }

  private async _resolveBinPath(): Promise<string> {
    if (this.options.binPath) {
      if (!existsSync(this.options.binPath)) {
        throw new AgentSpawnError(
          `pi binPath does not exist: ${this.options.binPath}`,
        );
      }
      return this.options.binPath;
    }
    return resolveAgentBinary('pi', 'pi');
  }
}
