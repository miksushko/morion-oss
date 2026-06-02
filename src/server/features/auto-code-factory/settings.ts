import type { ToolContext } from '../../tools/types.js';
import { AUTO_CODE_MONTHLY_CAP_USD } from '../../../core/concierge/budget.js';
import { runPreflight } from '../../../core/auto-code/preflight.js';

/**
 * Workspace-wide auto-code monthly cap, in USD. Pulled from the
 * `auto_code.monthly_budget_usd` setting; falls back to the design
 * default when unset OR malformed. Single helper so route handlers
 * + the orchestrator factory + tests share one resolution path.
 */
export function readAutoCodeMonthlyCap(
  settings: ToolContext['settings'],
): number {
  const raw = settings.get<unknown>('auto_code.monthly_budget_usd', undefined);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return AUTO_CODE_MONTHLY_CAP_USD;
}

/**
 * Detect Claude's auth source. We treat presence of `ANTHROPIC_API_KEY`
 * (or its older `CLAUDE_API_KEY` alias) in the env as "API key" mode;
 * absence is "OAuth Max" since Claude Code falls back to OAuth tokens
 * stored in the keychain when no env key is set. Returns null when
 * the binary itself isn't on PATH (preflight failed) — caller surfaces
 * a generic label in that case. */
export function detectClaudeAuthSource(): 'oauth-max' | 'api-key' | null {
  const pf = runPreflight();
  if (!pf.claude.ready) return null;
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
  if (process.env.CLAUDE_API_KEY?.trim()) return 'api-key';
  return 'oauth-max';
}

