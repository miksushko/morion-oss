import { z } from 'zod';
import { defineTool } from '../types.js';
import {
  spawnSubMo,
  requireBudget,
  type MoOrchestratorDeps,
} from '../../../core/concierge/index.js';
import { redactSecrets } from '../../../core/concierge/redact.js';
import { bodyHash } from './receipt.js';
import {
  readChatModelFallback,
  readProviderModel,
} from '../../features/concierge-deps/index.js';
import type { ToolContext } from '../types.js';

/**
 * Workspace-level Mo memory write tool.
 *
 * Like Claude / ChatGPT memory but scoped to one Morion notebook.
 * Mo reads existing memory + the proposed fact, decides one of:
 *
 *   - `added`     — fact integrated into memory (Mo returns the
 *                   full rewritten body so it can re-organize when
 *                   the merge is non-trivial — e.g. lifting two
 *                   related items into a shared section).
 *   - `deduped`   — fact already known, no write. Returns the
 *                   matching existing memory line so the agent can
 *                   tell the user "already there".
 *   - `conflict`  — fact contradicts something in memory. NO write.
 *                   Returns `{existing, proposed, question}` so the
 *                   agent can surface to the user and re-call with
 *                   the resolution.
 *
 * No folderId — memory is workspace-wide. budget
 * gates apply (LLM-tier).
 *
 * The agent does NOT pre-format. Mo's prompt asks for one JSON object
 * with the action + (when added) the new full body. Agent passes a
 * one-liner like "user prefers structured Context/Why/Rule postmortem
 * format for decisions" and Mo decides where it lands.
 */

const ACTIONS = ['added', 'deduped', 'conflict'] as const;
type Action = typeof ACTIONS[number];

interface MoMemoryDecision {
  action: Action;
  /** Full new memory body (action='added'). */
  body?: string;
  /** Existing matching line (action='deduped' or 'conflict'). */
  existing?: string;
  /** Proposed fact echoed back (action='conflict'). */
  proposed?: string;
  /** Clarifying question for the user (action='conflict'). */
  question?: string;
  /** Mo's one-line reasoning for the action chosen. */
  reason?: string;
}

const MEMORY_PROMPT = (currentMemory: string, override: boolean) => {
  const baseHeader = [
    'You are Mo, the project memory keeper for a Morion notebook.',
    'A new fact is being proposed for the workspace-wide memory.',
    '',
    'Existing memory:',
    currentMemory.trim() ? '```\n' + currentMemory.trim() + '\n```' : '_(empty)_',
    '',
  ];

  // Override mode: the calling agent has confirmed (after a previous
  // `conflict` round-trip) that the user wants this fact to win even
  // if it contradicts existing memory. Sub-Mo MUST take action='added'
  // and is now allowed to REPLACE / DELETE contradicting items.
  // Without this branch sub-Mo would loop returning `conflict` forever
  // because there's no other way to express "user resolved this".
  if (override) {
    return [
      ...baseHeader,
      'OVERRIDE MODE: the user has explicitly confirmed they want this fact to be written, replacing any contradicting items in existing memory. Take action=`added`. If the proposed fact contradicts an existing line, REMOVE the contradicting line and add the new one. Keep all unrelated existing facts intact. `deduped` and `conflict` are NOT valid outputs in this mode.',
      '',
      'Return ONE JSON object:',
      '  { "action": "added", "body": "<full new memory body with contradicting items replaced>", "reason": "<one short sentence>" }',
      '',
      'Memory body conventions:',
      '- Plain markdown. Use `## <heading>` to group related facts (e.g. `## Preferences`, `## Decisions`, `## Project conventions`). Use bullets inside sections.',
      '- Keep facts atomic — one bullet per fact.',
      '- Only the contradicting items are replaced. Other unrelated existing facts MUST stay.',
    ].join('\n');
  }

  return [
    ...baseHeader,
    'Decide ONE of:',
    '  - `added`    — the fact is new + non-conflicting. Integrate into the memory body. Reorganise sections only if the merge demands it (e.g. promote two related items into a shared `## <heading>`). DO NOT delete existing items.',
    '  - `deduped`  — the fact (or its essence) is already in memory. No write. Quote the matching existing line.',
    '  - `conflict` — the fact contradicts something in memory. NO write. Return what already says + the proposed fact + a one-line clarifying question for the user.',
    '',
    'Return ONE JSON object:',
    '  { "action": "added", "body": "<full new memory body>", "reason": "<one short sentence>" }',
    '  { "action": "deduped", "existing": "<the matching line from memory>", "reason": "<one short sentence>" }',
    '  { "action": "conflict", "existing": "<contradicting line>", "proposed": "<the proposed fact>", "question": "<one-line question for the user>", "reason": "<one short sentence>" }',
    '',
    'Memory body conventions:',
    '- Plain markdown. Use `## <heading>` to group related facts (e.g. `## Preferences`, `## Decisions`, `## Project conventions`). Use bullets inside sections.',
    '- Keep facts atomic — one bullet per fact.',
    '- Never invent facts not in the existing memory or the proposed fact.',
    '- When ambiguous (paraphrase vs. genuinely new), default to `added` rather than `deduped` — losing duplication is a smaller harm than losing information.',
  ].join('\n');
};

function parseDecision(raw: string): MoMemoryDecision | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const action = parsed.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as Action)) return null;
    const out: MoMemoryDecision = { action: action as Action };
    if (typeof parsed.body === 'string') out.body = parsed.body;
    if (typeof parsed.existing === 'string') out.existing = parsed.existing;
    if (typeof parsed.proposed === 'string') out.proposed = parsed.proposed;
    if (typeof parsed.question === 'string') out.question = parsed.question;
    if (typeof parsed.reason === 'string') out.reason = parsed.reason;
    return out;
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

export const moRememberTool = defineTool({
  name: 'mo_remember',
  category: 'create',
  // Memory is editable so any single write is reversible from the
  // Settings UI — but it surfaces in audit and changes Mo's behavior
  // workspace-wide, so flag as destructive for clients that highlight.
  annotations: { destructiveHint: true },
  description:
    "Add a fact to Mo's workspace-wide memory. Mo reads the existing memory, then decides one of: `added` (integrated), `deduped` (already known), or `conflict` (contradicts; needs user clarification, NO write). Budget-gated. Memory is workspace-scoped (one notebook = one Mo memory) — surfaces in every smart tool's system prompt so durable preferences / decisions / conventions persist across folders + sessions. The agent should NOT pre-format — pass a one-line fact like 'user prefers structured Context/Why/Rule postmortem format for decisions' and Mo decides where it lands. After receiving action='conflict' and surfacing the question to the user: when the user's reply confirms the proposed fact should win, call again with the SAME fact AND override=true to force-replace the contradicting items.",
  inputShape: {
    fact: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "The fact to remember. One sentence ideal; at most a short paragraph. Mo decides the section / structure when integrating into the existing memory body.",
      ),
    override: z
      .boolean()
      .optional()
      .describe(
        "Set to true ONLY after a prior call returned action='conflict' and the user has explicitly confirmed the proposed fact should win. Forces action='added' and replaces contradicting items in memory. Default false.",
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

    const denial = requireBudget(ctx.concierge.budget);
    if (denial) return denial;

    // Redact secrets from the proposed fact BEFORE Mo sees it. Memory
    // sticks around forever; an API key landing here would be
    // particularly bad.
    const redacted = redactSecrets(input.fact);
    const warnings: string[] = [];
    if (redacted.hits > 0) {
      warnings.push(
        `Redacted ${redacted.hits} possible secret(s) from your fact before saving. Memory must never store credentials.`,
      );
    }

    const memory = ctx.concierge.moMemory;
    const before = memory.read();
    const beforeHash = bodyHash(before);

    const override = input.override ?? false;
    const deps = buildOrchestratorDeps(ctx);
    let resp;
    try {
      resp = await spawnSubMo(deps, {
        systemPrompt: MEMORY_PROMPT(before, override),
        userPrompt: `Proposed fact:\n${redacted.text}`,
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
        message: 'Mo returned an unparseable decision shape. Retry — this is a transient model issue.',
      };
    }

    // Override mode is a contract with sub-Mo: action MUST be 'added'.
    // If sub-Mo ignored the OVERRIDE block and returned conflict /
    // deduped anyway, force-promote to added with an empty-body sentinel
    // → falls through to the "no body" error below, which is the
    // honest signal to the agent to retry.
    if (override && decision.action !== 'added') {
      return {
        error: 'mo_decision_invalid',
        message:
          "Override mode requires action='added' but the memory keeper returned " +
          `'${decision.action}'. Retry — this is a transient model issue.`,
      };
    }

    if (decision.action === 'deduped') {
      return {
        ok: true as const,
        action: 'deduped' as const,
        existing: decision.existing ?? null,
        beforeHash,
        afterHash: beforeHash,
        reason: decision.reason ?? 'Already in memory; no write.',
        warnings,
      };
    }

    if (decision.action === 'conflict') {
      return {
        ok: true as const,
        action: 'conflict' as const,
        existing: decision.existing ?? null,
        proposed: decision.proposed ?? redacted.text,
        question: decision.question ?? 'Existing memory contradicts the proposed fact. Resolve and retry?',
        beforeHash,
        afterHash: beforeHash,
        reason: decision.reason ?? 'Contradicts existing memory; no write.',
        warnings,
      };
    }

    // action === 'added'
    if (typeof decision.body !== 'string' || decision.body.trim().length === 0) {
      return {
        error: 'mo_decision_invalid',
        message: 'Mo decided to add but returned no body. Retry.',
      };
    }
    memory.write(decision.body);
    const afterHash = bodyHash(decision.body);

    return {
      ok: true as const,
      action: 'added' as const,
      beforeHash,
      afterHash,
      reason: decision.reason ?? 'Integrated into memory.',
      warnings,
    };
  },
});
