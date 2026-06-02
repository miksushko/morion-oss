import type { CanvasAgent, CanvasStage } from './types';

/**
 * Per-stage UI metadata: agent option lists, provider compatibility
 * matrix, level enums, model-input placeholders, footnotes, and the
 * shared select-element classes.
 *
 * Kept as pure helpers so the upcoming body-panel components can import
 * them without dragging in the main editor file.
 */

export const AGENT_OPTIONS: CanvasAgent[] = ['claude', 'codex', 'pi', 'opencode'];

/** Per-tool Provider compatibility. Each CLI tool authenticates against
 *  a specific provider's API surface:
 *
 *    - Claude Code → Anthropic only
 *    - Codex       → OpenAI only
 *    - pi          → typically OpenRouter / Groq / Ollama for OSS models;
 *                    also accepts OpenAI/Anthropic
 *    - opencode    → broad — any of the providers below
 *
 *  `canonical` is the provider stored as `null` (= "no override") so
 *  opening a fresh template doesn't accidentally flip workflows into
 *  draft mode just because the dropdown displays a value. Picking any
 *  non-canonical option from `options` IS treated as an override and
 *  routes through the v2 draft save-path. */
interface ToolProviderInfo {
  readonly canonical: string;
  readonly options: readonly string[];
}

const TOOL_PROVIDER_MAP: Record<CanvasAgent, ToolProviderInfo> = {
  claude: { canonical: 'anthropic', options: ['anthropic'] },
  codex: { canonical: 'openai', options: ['openai'] },
  pi: {
    canonical: 'openrouter',
    options: ['openrouter', 'groq', 'ollama', 'openai', 'anthropic'],
  },
  opencode: {
    canonical: 'openrouter',
    options: ['openrouter', 'anthropic', 'openai', 'groq', 'ollama'],
  },
};

export function providerOptionsFor(tool: CanvasAgent): readonly string[] {
  return TOOL_PROVIDER_MAP[tool]?.options ?? [];
}

export function canonicalProviderFor(tool: CanvasAgent): string {
  return TOOL_PROVIDER_MAP[tool]?.canonical ?? '';
}

/** Shared styling for `<select>` elements. `appearance-none` removes the
 *  native chevron — Tauri's WebKit ignored `padding-right` on selects
 *  and rendered the indicator flush against the right edge. The CSS
 *  background image below paints a custom chevron at a deterministic
 *  offset. */
export const SELECT_CLASS =
  'appearance-none rounded-md border border-border bg-background pl-2 pr-7 py-1 text-[11px] text-foreground ' +
  "bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%239ca3af%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22><polyline%20points=%226%209%2012%2015%2018%209%22/></svg>')] " +
  "bg-[length:0.75rem] bg-[position:right_0.5rem_center] bg-no-repeat";

const CLAUDE_LEVELS = ['Default', 'Think', 'ThinkHard', 'ThinkHarder', 'Ultrathink'];
const CODEX_LEVELS = ['Default', 'Low', 'Medium', 'High'];
const DEFAULT_ONLY_LEVELS = ['Default'];

export function levelOptionsFor(agent: string | null | undefined): string[] {
  if (agent === 'claude') return CLAUDE_LEVELS;
  if (agent === 'codex') return CODEX_LEVELS;
  // pi / opencode / antigravity / openrouter-generic — single option.
  return DEFAULT_ONLY_LEVELS;
}

/** Adapter-aware placeholder for the cli_agent Model field. Pi /
 *  opencode users want OpenRouter / Ollama / Groq model ids, not the
 *  claude-specific examples. Empty stored value still means "adapter
 *  default" — this is purely a UX hint. */
export function modelPlaceholderFor(agent: string | null | undefined): string {
  if (agent === 'claude') return '(e.g. claude-opus-4-7, claude-sonnet-4-6)';
  if (agent === 'codex') return '(e.g. gpt-5, o4-mini)';
  if (agent === 'pi') {
    return '(e.g. qwen2.5-coder:14b for Ollama, anthropic/claude-opus-4-7 for OpenRouter)';
  }
  if (agent === 'opencode') {
    return '(e.g. anthropic/claude-opus-4-7, openai/gpt-5, qwen/qwen-coder)';
  }
  return '(vendor-native model id)';
}

/** Adapter-aware footnote under the Level dropdown. Surfaces caveats
 *  so the user knows whether their pick will actually flow through. */
export function levelFootnoteFor(agent: string | null | undefined): string | null {
  if (agent === 'claude') {
    return 'Inlined as a "think" prompt idiom (no CLI flag).';
  }
  if (agent === 'codex') {
    return 'Forwarded as --reasoning-effort only when MORION_CODEX_REASONING_EFFORT=1 is set in the sidecar env (newer Rust codex CLI). Legacy 0.1.x Node CLI silently ignores.';
  }
  return null;
}

// ---------------------------------------------------------------------
// Node visual styling — used by both StageNode and StagePanel header
// ---------------------------------------------------------------------

export const KIND_STYLES: Record<CanvasStage['kind'], string> = {
  cli_agent: 'border-blue-500/60 bg-blue-500/10',
  mcp_tool_call: 'border-amber-500/60 bg-amber-500/10',
  human_gate: 'border-emerald-500/60 bg-emerald-500/10',
  branch: 'border-purple-500/60 bg-purple-500/10',
  mo_router: 'border-fuchsia-500/60 bg-fuchsia-500/10',
  eject: 'border-destructive/70 bg-destructive/10',
  // v2 spec — Mo decision uses the same fuchsia as legacy mo_router so the
  // visual concept (Mo decides routing) stays consistent across the alias.
  mo_stage: 'border-fuchsia-500/60 bg-fuchsia-500/10',
  reject_sink: 'border-destructive/70 bg-destructive/10',
  complete_sink: 'border-emerald-600/70 bg-emerald-500/15',
};

export const KIND_LABELS: Record<CanvasStage['kind'], string> = {
  cli_agent: 'CLI agent',
  mcp_tool_call: 'MCP tool',
  human_gate: 'Human · In the loop',
  branch: 'Branch',
  mo_router: 'Mo router (deprecated)',
  eject: 'Eject (deprecated)',
  mo_stage: 'Mo stage',
  reject_sink: 'Reject sink',
  complete_sink: 'Complete sink',
};
