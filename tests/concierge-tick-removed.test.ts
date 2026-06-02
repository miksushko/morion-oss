import { describe, it, expect } from 'vitest';
import * as ConciergeIndex from '../src/core/concierge/index.js';

/**
 * Regression test for ticket `01KQVA65TJ2VCY8VCKH9N5F6W8` (2026-05-05) —
 * "Disable Mo Concierge".
 *
 * Two prior commits already cut the live wiring:
 *   - 34bab55 (2026-05-03): scheduler stopped iterating Mo-enabled
 *     folders, /launch HTTP route deleted, UI Schedule pills removed.
 *   - 4789bc9 (2026-05-04): chat-tier toolset filtered to drop
 *     `tasks_move` / `tasks_claim` / `notes_add_comment` / etc, plus
 *     a "Reactive, not proactive" hard rule in the chat system prompt.
 *
 * What this ticket removed: the dead-code island left behind —
 * `runConciergeTick`, `CONCIERGE_TOOLS`, the tick-side prompt builders
 * (`buildSystemPrompt` / `buildUserPrompt` / `wrapUserContent`), the
 * `concierge_actions` repository + its HTTP route + the workspace-
 * level Action log tab. None of them had live callers (verified by
 * `tsc --noEmit` after deletion + grep across `src/`), but their
 * presence was a hidden bomb — any future "let me wire Mo to do X"
 * commit would land back here without re-reading the autonomous-Mo
 * decision history.
 *
 * The test below pins the deletion: every dead symbol is asserted
 * absent from the public `core/concierge` re-export surface. If a
 * future change re-introduces any of them, this test will fail
 * loudly with the symbol name in the error message.
 *
 * Symbols that legitimately stay (chat path, indexing pipeline,
 * topic-cleanup, gather engine, sub-Mo orchestration, Mo memory) are
 * NOT asserted here — they're load-bearing for `mo_*` tools and
 * `Ask Mo`, and removing them would cascade into a separate redesign.
 *
 * If a future ticket needs to re-add ANY of these symbols, the
 * answer is NOT to satisfy this test — it's to bring back the
 * autonomous Mo decision to the user explicitly. The dead-code
 * island is a feature gate, not just a cleanup.
 */
describe('Mo Concierge autonomous-tick surface stays deleted', () => {
  const removedSymbols: ReadonlyArray<string> = [
    // Tick engine
    'runConciergeTick',
    // Tick prompt builders
    'buildSystemPrompt',
    'buildUserPrompt',
    'wrapUserContent',
    // Tick tool registry
    'CONCIERGE_TOOLS',
    // Action log repository
    'ConciergeActionsRepository',
    // Default workflow text (only fed the tick prompt)
    'DEFAULT_CONCIERGE_WORKFLOW',
  ];

  for (const name of removedSymbols) {
    it(`does not re-export \`${name}\` from core/concierge`, () => {
      expect((ConciergeIndex as Record<string, unknown>)[name]).toBeUndefined();
    });
  }

  it('chat-tier surface stays alive (sanity check — these MUST exist)', () => {
    // Belt-and-braces: if the cleanup accidentally over-reaches, the
    // chat path breaks. These symbols feed buildChatSystemPrompt and
    // the Ask Mo dispatch loop; deleting any of them is the actual
    // regression we'd want to catch.
    const r = ConciergeIndex as Record<string, unknown>;
    expect(typeof r.buildChatSystemPrompt).toBe('function');
    expect(typeof r.completeWithFallback).toBe('function');
    expect(typeof r.gatherContext).toBe('function');
    expect(typeof r.spawnSubMo).toBe('function');
    expect(typeof r.dispatchMoTool).toBe('function');
  });
});
