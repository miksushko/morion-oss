/**
 * Auto-code CLI Agent Harness — `claude` adapter (L1.T3).
 *
 * Spawns the Anthropic Claude Code CLI as a subprocess, parses its
 * `--output-format json` envelope, synthesises the unified
 * `CliAgentEvent` stream, and exposes resume + cancel + cost.
 *
 * CLI invocation (preserves the legacy claude-launcher contract):
 *
 *     claude -p "<prompt>" \
 *       --session-id <uuid>          [or --resume <uuid> on resume]
 *       --output-format json \
 *       --allowedTools "Read,Write,Edit,Glob,Grep,Bash" \
 *       --permission-mode acceptEdits \
 *       [--model <name>] \
 *       [--max-budget-usd <n>]
 *
 * **No `--bare`.** Bare mode forces `ANTHROPIC_API_KEY` auth and
 * bypasses the user's OAuth Max-plan keychain. The harness preserves
 * the legacy invariant of letting claude pick its auth path (OAuth
 * in production, API key when env present).
 *
 * **No `--worktree`.** Per the harness contract, callers (L2 workflow
 * runner) own worktree creation and pass `cwd` directly. Resume MUST
 * use the same `cwd` as the original spawn — claude looks up the
 * session transcript on disk via cwd-encoding, and a cwd mismatch
 * produces a fresh session with no memory of the prior turn.
 *
 * **Single-envelope mode.** `--output-format json` emits ONE JSON
 * envelope as the last non-empty stdout line. The adapter:
 *   - Synthesises `session_start` with the pre-allocated sessionId
 *     immediately after the spawn handshake (via `AbstractAgentHandle`).
 *   - At envelope decode, emits `result` (clean / budget) OR `error`
 *     (failure terminal_reason / non-zero exit / no envelope at all).
 *
 * Events NOT emitted in v1 (single-envelope mode is too coarse):
 *   - `text_delta` / `message` / `tool_start` / `tool_end` —
 *     `--output-format stream-json` (NDJSON deltas) would surface
 *     these. Out of scope for v1; L4 may revisit.
 */

import { existsSync } from 'node:fs';

import {
  AgentSpawnError,
  type AgentHandle,
  type CliAgentAdapter,
  type SpawnOptions,
} from '../adapter.js';
import { AbstractAgentHandle } from '../abstract-handle.js';
import {
  DEFAULT_TIMEOUT_MS,
  type AbstractHandleParams,
} from '../abstract-handle-types.js';
import type { AgentName } from '../events.js';
import { generateSessionId, resolveAgentBinary } from '../util.js';

const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
];

// ---------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  /** Override binary path. When omitted, the adapter resolves via
   *  `MORION_CLAUDE_BIN` env var, then `which claude` on PATH. */
  binPath?: string;
}

export class ClaudeAdapter implements CliAgentAdapter {
  readonly name: AgentName = 'claude';

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const binPath = await this._resolveBinPath();
    // Workflow Editor v2 `cli_agent.level` for Claude maps to the
    // extended-thinking prompt idioms (no CLI flag — Claude Code reads
    // these as a tier hint). Mapping per spec note 01KRAQWPXR5AYTFVF6J12TYHJ1:
    //   Default     → no prefix
    //   Think       → "think"
    //   ThinkHard   → "think hard"
    //   ThinkHarder → "think harder"
    //   Ultrathink  → "ultrathink"
    // Unrecognised values fall through with no prefix so a typo can't
    // silently change behaviour. The prefix is on a leading line so it
    // doesn't disturb the structure of the workflow's promptTemplate.
    const promptWithLevel = applyClaudeLevelIdiom(opts.prompt, opts.level);
    // Phase 6 V2 hotfix (2026-05-13) — when caller supplies
    // `resumeSessionId`, spawn in resume mode against that prior
    // session. Claude `--resume <id>` continues the existing
    // conversation; `prompt` becomes the next user turn (empty
    // string is valid).
    const resumeId = opts.resumeSessionId;
    return ClaudeAgentHandle._start({
      binPath,
      sessionId: resumeId ?? opts.sessionId ?? generateSessionId(),
      agent: 'claude',
      mode: resumeId ? 'resume' : 'fresh',
      prompt: promptWithLevel,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      model: opts.model,
      maxBudgetUsd: opts.maxBudgetUsd,
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
          `claude binPath does not exist: ${this.options.binPath}`,
        );
      }
      return this.options.binPath;
    }
    return resolveAgentBinary('claude', 'claude');
  }
}

// ---------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------

interface HandleParams extends AbstractHandleParams {
  mode: 'fresh' | 'resume';
  allowedTools?: readonly string[];
  model?: string;
  maxBudgetUsd?: number;
}

class ClaudeAgentHandle extends AbstractAgentHandle {
  private readonly _claudeParams: HandleParams;

  static async _start(params: HandleParams): Promise<ClaudeAgentHandle> {
    const handle = new ClaudeAgentHandle(params);
    await handle._spawnChild();
    return handle;
  }

  private constructor(params: HandleParams) {
    super(params);
    this._claudeParams = params;
  }

  protected _buildArgs(): string[] {
    const p = this._claudeParams;
    const tools = (p.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(',');
    const args: string[] = ['-p', p.prompt];
    if (p.mode === 'resume') {
      args.push('--resume', this.sessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }
    args.push(
      '--output-format',
      'json',
      '--allowedTools',
      tools,
      '--permission-mode',
      'acceptEdits',
      // Isolate MCP: without this, the spawned claude inherits the
      // operator's global `~/.claude.json` + the worktree's project
      // config and tries to connect to EVERY configured MCP server
      // (figma / gmail / supabase / …). In a headless worktree those
      // interactive/auth servers hang at startup — claude sits for
      // minutes producing no output, then exits 1 (cost $0, before any
      // model turn). Under a parallel ticket fan-out this fails most
      // runs non-deterministically. Auto-code agents use built-in tools
      // only (DEFAULT_ALLOWED_TOOLS has no `mcp__*`), so we want zero
      // MCP servers: `--strict-mcp-config` with no `--mcp-config` means
      // "ignore all inherited MCP config".
      '--strict-mcp-config',
    );
    if (p.model) {
      args.push('--model', p.model);
    }
    if (p.maxBudgetUsd !== undefined && p.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(p.maxBudgetUsd));
    }
    return args;
  }

  protected _handleNormalClose(stdout: string, code: number | null): void {
    const parsed = parseClaudeEnvelope(stdout);
    if (!parsed) {
      this._emitTerminal({
        kind: 'error',
        errorKind: 'parse_failed',
        message:
          this._stderrTailTrimmed() ||
          `claude exited with code ${code} but produced no JSON envelope`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }

    const cost =
      typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
    this._cost = cost;

    const claudeReason = mapClaudeTerminalReason(parsed, code);
    if (claudeReason === 'error') {
      this._emitTerminal({
        kind: 'error',
        errorKind: 'non_zero_exit',
        message:
          typeof parsed.result === 'string'
            ? parsed.result
            : `claude reported error (exit=${code})`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }

    // 'completed' OR 'budget' — both surface as result events with
    // a discriminating `terminalReason`. Workflow runner (L2)
    // distinguishes via terminalReason, NOT via comparing costUsd
    // to cap (the comparison is approximate due to rounding).
    this._emitTerminal({
      kind: 'result',
      exitCode: code ?? 0,
      summary: typeof parsed.result === 'string' ? parsed.result : '',
      costUsd: cost,
      terminalReason: claudeReason,
      timestamp: Date.now(),
    });
  }

  override async resume(injectedMessage?: string): Promise<AgentHandle> {
    // Claude is single-envelope (terminal event arrives ON close), so
    // _terminalEventEmitted ↔ _processReaped are effectively
    // equivalent. Use _processReaped for consistency with streaming
    // adapters (pi/opencode) per Codex T10 review P1.
    if (!this._processReaped) {
      throw new AgentSpawnError(
        'cannot resume — process has not been reaped yet. Await `handle.exited` before calling resume().',
      );
    }
    return ClaudeAgentHandle._start({
      ...this._claudeParams,
      mode: 'resume',
      // Use injected message as the next user turn. Empty string is
      // valid — claude treats it as "continue without new input".
      prompt: injectedMessage ?? '',
    });
  }
}

// ---------------------------------------------------------------------
// Envelope parsing — lifted from legacy claude-launcher (same logic).
// ---------------------------------------------------------------------

type ClaudeEnvelope = Record<string, unknown>;

/** Walk lines from the bottom up — claude `--output-format json`
 *  emits the envelope as the LAST non-empty stdout line. Other lines
 *  are logs / status that we ignore. */
function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as ClaudeEnvelope;
      }
    } catch {
      continue;
    }
  }
  return null;
}

type ClaudeTerminalReason = 'completed' | 'budget' | 'error';

function mapClaudeTerminalReason(
  parsed: ClaudeEnvelope,
  exitCode: number | null,
): ClaudeTerminalReason {
  if (parsed.is_error === true) return 'error';
  if (typeof parsed.terminal_reason === 'string') {
    const tr = parsed.terminal_reason;
    if (tr === 'completed') return 'completed';
    if (tr === 'budget') return 'budget';
    if (tr === 'error') return 'error';
  }
  if (typeof parsed.subtype === 'string') {
    if (parsed.subtype === 'success') return 'completed';
    if (parsed.subtype === 'error') return 'error';
  }
  return exitCode === 0 ? 'completed' : 'error';
}

/** Map Workflow Editor v2 `cli_agent.level` to Claude Code's
 *  extended-thinking prompt idiom. Returns the prompt with a leading
 *  idiom line prepended on a match; otherwise the prompt verbatim.
 *  Exported for unit-test pin-down. */
export function applyClaudeLevelIdiom(
  prompt: string,
  level: string | undefined,
): string {
  if (!level || level === 'Default') return prompt;
  const idiomByLevel: Record<string, string> = {
    Think: 'think',
    ThinkHard: 'think hard',
    ThinkHarder: 'think harder',
    Ultrathink: 'ultrathink',
  };
  const idiom = idiomByLevel[level];
  if (!idiom) return prompt;
  return `${idiom}\n\n${prompt}`;
}
