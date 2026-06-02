import { describe, it, expect, beforeEach } from 'vitest';
import { runMoIndexingTick } from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  tier1Json,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — Tier 2 hook (Phase 3c)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('runs drainTier2Queue after Tier 1 — cluster regen happens on the NEXT tick (debounce)', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );

    // First provider response: Tier 1 JSON (kanban-ui cluster).
    // 2nd: Tier 2 cluster body. 3rd: Tier 2.5 catalog body (the hook
    // added in Phase 4b regenerates the folder catalog after every
    // Tier 2 success; we provide a catalog body so the call doesn't
    // fall through to "invalid_response").
    let callIdx = 0;
    const responses = [
      tier1Json,
      [
        '<!-- mo:section-start id="overview" -->',
        'Cluster covers kanban UI work.',
        '<!-- mo:section-end id="overview" -->',
      ].join('\n'),
      [
        '<!-- mo:section-start id="overview" -->',
        'Folder catalog overview.',
        '<!-- mo:section-end id="overview" -->',
      ].join('\n'),
    ];
    class TimedStub implements LLMProvider {
      readonly name = 'timed-stub';
      public calls: LLMRequest[] = [];
      async complete(req: LLMRequest): Promise<LLMResponse> {
        this.calls.push(req);
        const content = responses[callIdx++] ?? '';
        return {
          content,
          toolCalls: [],
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0.0001,
          model: req.model,
        };
      }
    }
    const provider = new TimedStub();

    // First tick at t=1000: Tier 1 fires; cluster enqueued with
    // dirty_since=1000. Tier 2 debounce (default 60_000) means it
    // CANNOT claim the cluster in this same tick — confirmed by
    // tier2.claimed === 0 below.
    let nowValue = 1000;
    const deps = buildDeps(ctx, {
      provider,
      tier1Model: 'tier-1-model',
      tier1FallbackModel: null,
      tier2Model: 'tier-2-model',
      tier2FallbackModel: null,
    });
    deps.now = () => nowValue;

    const tick1 = await runMoIndexingTick(deps);
    expect(tick1.worker?.computed).toBe(1);
    expect(tick1.tier2?.claimed).toBe(0);
    expect(provider.calls).toHaveLength(1); // only Tier 1 called

    // Second tick at t=70_000 — debounce window cleared
    // (70_000 - 60_000 = 10_000 > cluster's dirty_since=1000).
    // Calls expected: 1 Tier 2 cluster regen + 1 Tier 2.5 catalog regen
    // (Phase 4b hook fires per folder with Tier 2 success).
    nowValue = 70_000;
    const tick2 = await runMoIndexingTick(deps);
    expect(tick2.tier2?.claimed).toBe(1);
    expect(tick2.tier2?.computed).toBe(1);
    expect(tick2.tier25?.length).toBe(1);
    expect(tick2.tier25?.[0]?.status).toBe('computed');
    expect(provider.calls).toHaveLength(3); // 1 tier1 + 1 tier2 + 1 tier2.5
    expect(provider.calls[1]!.model).toBe('tier-2-model');
    expect(provider.calls[2]!.model).toBe('tier-2-model'); // tier 2.5 reuses tier2 model

    // Cluster aggregator note now exists.
    const aggregator = ctx.handle.db
      .prepare<[string, string], { id: string; body: string }>(
        `SELECT id, body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:cluster');
    expect(aggregator).toBeDefined();
    expect(aggregator!.body).toContain('Cluster covers kanban UI work');

    // Catalog note also materialised (Phase 4b hook).
    const catalog = ctx.handle.db
      .prepare<[string, string], { id: string; body: string }>(
        `SELECT id, body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:catalog');
    expect(catalog).toBeDefined();
    expect(catalog!.body).toContain('Folder catalog overview');
  });
});
