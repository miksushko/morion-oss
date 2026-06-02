/**
 * UI placeholder constants — recommended model ids surfaced as typing
 * aids in the Mo provider settings. NEVER used as shipped defaults
 * (CLAUDE.md "no hardcoded model defaults" rule). Vendor IDs go stale
 * fast; an empty stored model lets the user fill in whatever the
 * current pick is.
 *
 * Costs (per 1M tokens, approximate, OpenRouter listings):
 *   - Gather subagent (Wave 1+2 workers): qwen/qwen3.5-flash  ~$0.065 / $0.26
 *   - Gather synth (default):             deepseek/deepseek-v4-flash  $0.14 / $0.28
 *   - Gather synth (thorough):            deepseek/deepseek-v4-pro    $0.435 / $0.87
 *   - Merge resolver primary:             deepseek/deepseek-v4-pro    $0.435 / $0.87
 *   - Merge resolver fallback:            anthropic/claude-sonnet-4   $3.00 / $15.00
 */
export const GATHER_SUBAGENT_RECOMMENDED = 'qwen/qwen3.5-flash';
export const GATHER_SYNTHESIS_DEFAULT_RECOMMENDED = 'deepseek/deepseek-v4-flash';
export const GATHER_SYNTHESIS_THOROUGH_RECOMMENDED = 'deepseek/deepseek-v4-pro';

export const MERGE_RESOLVER_PRIMARY_RECOMMENDED = 'deepseek/deepseek-v4-pro';
export const MERGE_RESOLVER_FALLBACK_RECOMMENDED = 'anthropic/claude-sonnet-4';
