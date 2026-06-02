import { z } from 'zod';
import { defineTool } from '../types.js';
import {
  spawnSubMo,
  requireBudget,
  type MoOrchestratorDeps,
} from '../../../core/concierge/index.js';
import { bodyHash } from './receipt.js';
import {
  readChatModelFallback,
  readProviderModel,
} from '../../features/concierge-deps/index.js';
import type { ToolContext } from '../types.js';

/**
 * Workspace-level Mo memory REMOVAL.
 *
 * Companion to `mo_remember` (which only ADDS). Two modes:
 *
 *   - `{all: true}` — wipe the entire memory body. Deterministic; no
 *     LLM call. Use when the user says "forget everything", "clear
 *     memory", "забудь всё", "очисти память под ноль".
 *
 *   - `{pattern: "<topic or substring>"}` — drop items matching the
 *     pattern. LLM-tier — sub-Mo reads the existing body, decides
 *     which lines to remove, returns the rewritten body. Use for
 *     selective forgetting like "forget my address" / "забудь форму
 *     обращения".
 *
 * Why a separate tool from `mo_remember`:
 *   1. Semantics. `mo_remember` is "add a fact". Calling it with a
 *      meta-fact like "user asked to clear memory" adds the
 *      meta-statement instead of clearing — confusing for both Mo
 *      and the user. (Reproduced 2026-04-26 — Mo persona then
 *      confabulated success despite the tool returning an error.)
 *   2. Approval surface. `mo_forget` is `category: 'delete'` — the
 *      chat loop pauses and shows an approval card before running.
 *      `mo_remember` is `create` (not approval-gated) because adding
 *      a fact is recoverable; forgetting one is not.
 *   3. Audit clarity. `mo_forget` writes its own audit row showing
 *      WHAT was lost (the prior body or matching lines). Users can
 *      review in the "What Mo did" Settings panel.
 *
 * budget gate (LLM-tier path only — `all: true` is
 * free). Receipt envelope mirrors `mo_remember`:
 *   `{ok: true, removed, beforeHash, afterHash, reason, warnings?}`.
 */

const MO_FORGET_SYSTEM_PROMPT = (currentMemory: string) =>
  [
    'You are Mo, the project memory keeper for a Morion notebook.',
    'The user wants to REMOVE items matching a pattern from the memory body.',
    '',
    'Existing memory:',
    currentMemory.trim() ? '```\n' + currentMemory.trim() + '\n```' : '_(empty)_',
    '',
    'Walk every line / item in the memory and decide which ones the pattern targets. Drop the matches; keep everything else verbatim.',
    '',
    'Return ONE JSON object:',
    '  { "body": "<full new memory body, with matched items removed>", "removed": ["<short quote of each removed item>"], "reason": "<one short sentence>" }',
    '',
    'Rules:',
    '- If NO line matches the pattern, return the body unchanged + `removed: []`.',
    '- If EVERY line matches, return `body: ""` (empty string is valid).',
    '- Preserve section headings (`## ...`) when at least one bullet under that heading survives. Drop the heading too if it ends up with no bullets.',
    '- Never invent facts. Only remove or keep what was already there.',
  ].join('\n');

interface MoForgetDecision {
  body: string;
  removed: string[];
  reason?: string;
}

function parseDecision(raw: string): MoForgetDecision | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.body !== 'string') return null;
    const removed = Array.isArray(parsed.removed)
      ? parsed.removed.filter((x): x is string => typeof x === 'string')
      : [];
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    return { body: parsed.body, removed, reason };
  } catch {
    return null;
  }
}

function buildOrchestratorDeps(ctx: ToolContext): MoOrchestratorDeps {
  const host = {
    db: ctx.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    settings: ctx.settings,
    concierge: ctx.concierge!,
  };
  const { provider, model } = readProviderModel(host);
  return {
    provider,
    model,
    fallbackModel: readChatModelFallback(host),
    budget: ctx.concierge!.budget,
  };
}

export const moForgetTool = defineTool({
  name: 'mo_forget',
  // 'delete' so the chat loop pauses for user approval before
  // running. Memory is durable and the user almost never wants it
  // wiped without a beat to confirm.
  category: 'delete',
  annotations: { destructiveHint: true },
  description:
    "Remove items from Mo's workspace-wide memory. Use `{all: true}` to wipe the entire memory body (cheap, deterministic). Use `{pattern: '<topic or substring>'}` for selective forgetting (LLM-tier — sub-Mo decides which lines to drop). Destructive — chat path requires user approval before running. Returns a receipt with `{removed, beforeHash, afterHash}` so the audit log shows what was lost.",
  inputShape: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Wipe the ENTIRE memory body. Deterministic, no LLM call. Mutually exclusive with `pattern`.',
      ),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Topic or substring describing which items to forget (e.g. 'my address', 'форма обращения', 'API key conventions'). Sub-Mo walks every memory item and drops the matches. Mutually exclusive with `all`.",
      ),
  },
  async handler(input, ctx) {

    if (!ctx.concierge) {
      return {
        error: 'mo_internal',
        reason: 'concierge_not_wired',
        message: 'Mo subsystem is not available in this MCP context.',
      };
    }

    // XOR validation — exactly one of {all, pattern} must be set.
    const hasAll = input.all === true;
    const hasPattern = typeof input.pattern === 'string' && input.pattern.length > 0;
    if (hasAll === hasPattern) {
      return {
        error: 'mo_invalid_input',
        message:
          "Exactly one of `all: true` or `pattern: <string>` is required (not both, not neither).",
      };
    }

    const memory = ctx.concierge.moMemory;
    const before = memory.read();
    const beforeHash = bodyHash(before);

    // ---- Wipe-all path (deterministic) -----------------------------
    if (hasAll) {
      // Already empty? No-op, no audit noise.
      if (before.length === 0) {
        return {
          ok: true as const,
          mode: 'all' as const,
          removed: [],
          beforeHash,
          afterHash: beforeHash,
          reason: 'Memory was already empty.',
          warnings: [],
        };
      }
      memory.write('');
      return {
        ok: true as const,
        mode: 'all' as const,
        // Surface the prior body so audit shows exactly what was lost.
        // Capped to keep the receipt readable; full body lives in the
        // pre-write audit row anyway.
        removed: [before.length > 1000 ? before.slice(0, 1000) + '…' : before],
        beforeHash,
        afterHash: bodyHash(''),
        reason: 'All workspace memory wiped per user request.',
        warnings: [],
      };
    }

    // ---- Pattern path (LLM-tier) -----------------------------------
    const denial = requireBudget(ctx.concierge.budget);
    if (denial) return denial;

    if (before.length === 0) {
      return {
        ok: true as const,
        mode: 'pattern' as const,
        pattern: input.pattern,
        removed: [],
        beforeHash,
        afterHash: beforeHash,
        reason: 'Memory is empty — nothing to forget.',
        warnings: [],
      };
    }

    const deps = buildOrchestratorDeps(ctx);
    let resp;
    try {
      resp = await spawnSubMo(deps, {
        systemPrompt: MO_FORGET_SYSTEM_PROMPT(before),
        userPrompt: `Pattern: ${input.pattern}`,
        folderId: null,
      });
    } catch (err) {
      return {
        error: 'mo_provider_error',
        message: `Memory keeper failed: ${(err as Error).message.slice(0, 200)}`,
      };
    }

    const decision = parseDecision(resp.content);
    if (!decision) {
      return {
        error: 'mo_decision_invalid',
        message:
          'Mo returned an unparseable decision shape. Retry — this is a transient model issue.',
      };
    }

    // Sub-Mo decided to keep everything (pattern matched nothing).
    // Don't bother writing — same body, same hash.
    if (decision.body === before) {
      return {
        ok: true as const,
        mode: 'pattern' as const,
        pattern: input.pattern,
        removed: [],
        beforeHash,
        afterHash: beforeHash,
        reason: decision.reason ?? 'Pattern matched nothing in memory.',
        warnings: [],
      };
    }

    memory.write(decision.body);
    return {
      ok: true as const,
      mode: 'pattern' as const,
      pattern: input.pattern,
      removed: decision.removed,
      beforeHash,
      afterHash: bodyHash(decision.body),
      reason: decision.reason ?? `Removed items matching "${input.pattern}".`,
      warnings: [],
    };
  },
});
