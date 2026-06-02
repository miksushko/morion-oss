import type { ToolContext } from '../../tools/types.js';
import type { PreflightResult } from '../../../core/auto-code/preflight.js';
import { ClaudeAdapter } from '../../../core/auto-code/harness/adapters/claude.js';
import { CodexAdapter } from '../../../core/auto-code/harness/adapters/codex.js';
import { PiAdapter } from '../../../core/auto-code/harness/adapters/pi.js';
import { OpencodeAdapter } from '../../../core/auto-code/harness/adapters/opencode.js';
import type { CliAgentAdapter } from '../../../core/auto-code/harness/adapter.js';
import type { CliAgentName } from '../../../core/auto-code/workflows/types/index.js';
import {
  buildAgentApiKeyEnv,
} from '../../features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../../features/concierge-deps/index.js';
import { makeMissingBinaryAdapter } from './helpers.js';

/**
 * Build the per-agent adapter factory used by the workflow runner.
 * Closure-captures the toolCtx (for the shared-env host snapshot) +
 * the preflight result (so codex falls back to a synthetic
 * recoverable adapter when its binary isn't on PATH).
 *
 * Pi / Opencode adapters are wrapped with the shared-env injector so
 * Mo's configured provider keys (OpenRouter / Anthropic / OpenAI /
 * Groq / Ollama base URL) flow into spawned processes without a
 * separate `pi login` / `opencode login` step (Phase 4.6, 2026-05-11).
 *
 * Reads keys at every spawn (not memoized) — the user can rotate the
 * key mid-session and the next run picks up the new value.
 */
export function buildAdapterFactory(
  toolCtx: ToolContext,
  pf: PreflightResult,
): (agent: CliAgentName) => CliAgentAdapter {
  const buildHostForEnv = (): ConciergeDepsHost | null => {
    if (!toolCtx.concierge) return null;
    return {
      db: toolCtx.db,
      notes: toolCtx.notes,
      folders: toolCtx.folders,
      comments: toolCtx.comments,
      settings: toolCtx.settings,
      concierge: toolCtx.concierge,
      embeddings: toolCtx.embeddings,
    };
  };

  const wrapWithSharedEnv = (inner: CliAgentAdapter): CliAgentAdapter => ({
    name: inner.name,
    async spawn(opts) {
      const hostForEnv = buildHostForEnv();
      const sharedEnv = hostForEnv ? buildAgentApiKeyEnv(hostForEnv) : {};
      // Caller-supplied env wins (test injection / explicit per-run
      // overrides), Morion's shared keys fill the gaps.
      const mergedEnv = { ...sharedEnv, ...(opts.env ?? {}) };
      // OpenRouter-namespaced model defaulting (2026-05-13). Pi /
      // Opencode let you pass `--model <name>` without `--provider`;
      // their own routing then tries to parse the model id's prefix
      // (`deepseek/...`, `qwen/...`, `anthropic/...`) as a provider
      // name and look for that-named API key. That's wrong when the
      // model id is OpenRouter's namespaced form — those prefixes
      // map to OpenRouter, not to direct deepseek/qwen/anthropic
      // accounts. Real incident 2026-05-13: workflow `Default ·
      // Mo-driven (DeepSeek → Claude review)` uses
      // `deepseek/deepseek-v4-pro` on Pi; without an injected
      // provider Pi exited 1 with `No API key found for deepseek`
      // even though OPENROUTER_API_KEY was on env.
      //
      // Rule: when `opts.provider` isn't already set AND
      // `opts.model` contains `/` (namespaced shape) AND
      // OPENROUTER_API_KEY is on env, default provider to
      // 'openrouter'. Stage's explicit `provider` field still wins
      // (user can pin a non-OpenRouter routing if they want).
      let effectiveOpts = opts;
      const hasNamespacedModel =
        typeof opts.model === 'string' && opts.model.includes('/');
      if (!opts.provider && hasNamespacedModel && mergedEnv.OPENROUTER_API_KEY) {
        effectiveOpts = { ...opts, provider: 'openrouter' };
      }
      return inner.spawn({ ...effectiveOpts, env: mergedEnv });
    },
  });

  return (agent: CliAgentName): CliAgentAdapter => {
    switch (agent) {
      case 'claude':
        return new ClaudeAdapter({ binPath: pf.claude.path ?? undefined });
      case 'codex':
        // Without preflight readiness, the CodexAdapter would still
        // resolve via PATH lookup at spawn time and throw
        // AgentBinaryNotFoundError. Pre-flighted readiness lets us
        // surface the missing-binary signal as a synthetic
        // recoverable adapter so the runner's fallbackAgent retry
        // path activates immediately (otherwise the throw escaped
        // through the catch block as a non-recoverable failure).
        // Pinned by tests/workflow-runner-recoverable-spawn.test.ts.
        if (!pf.codex.ready) {
          return makeMissingBinaryAdapter('codex', pf.codex.error ?? 'codex binary not detected');
        }
        return new CodexAdapter({ binPath: pf.codex.path ?? undefined });
      case 'pi':
        // Wrapped — Pi reads provider API keys from env first, so
        // exposing Mo's stored keys here is the fast path to a
        // working install without `pi login`.
        return wrapWithSharedEnv(new PiAdapter());
      case 'opencode':
        // Same rationale for opencode — it reads OPENROUTER_API_KEY
        // / ANTHROPIC_API_KEY / OPENAI_API_KEY from env when its
        // own config doesn't already pin a key.
        return wrapWithSharedEnv(new OpencodeAdapter());
    }
  };
}
