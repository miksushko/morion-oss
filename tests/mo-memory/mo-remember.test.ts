import { describe, it, expect, beforeEach } from 'vitest';
import { moRememberTool } from '../../src/server/tools/index.js';
import { activatePro, setup, type Ctx } from '../helpers/mo-memory-setup.js';

describe('mo_remember', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('over-budget denied without LLM call', async () => {
    activatePro(ctx.tc);
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });
    ctx.provider.calls.length = 0;
    const r = (await moRememberTool.handler(
      { fact: 'x' },
      ctx.tc,
    )) as { reason?: string };
    expect(r.reason).toBe('monthly_cap_reached');
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('action=added writes the new body to memory', async () => {
    activatePro(ctx.tc);
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({
        action: 'added',
        body: '## Preferences\n- user prefers structured postmortems',
        reason: 'fresh insight, integrated under Preferences.',
      }),
      costUsd: 0.002,
    });
    const r = (await moRememberTool.handler(
      { fact: 'user prefers structured postmortems' },
      ctx.tc,
    )) as { ok: true; action: string };
    expect(r.ok).toBe(true);
    expect(r.action).toBe('added');
    expect(ctx.memory.read()).toContain('Preferences');
    expect(ctx.memory.read()).toContain('structured postmortems');
  });

  it('action=deduped does NOT write to memory', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- user prefers structured postmortems');
    const before = ctx.memory.read();
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({
        action: 'deduped',
        existing: '- user prefers structured postmortems',
        reason: 'already there',
      }),
      costUsd: 0.001,
    });
    const r = (await moRememberTool.handler(
      { fact: 'user likes structured postmortems' },
      ctx.tc,
    )) as { action: string; existing?: string };
    expect(r.action).toBe('deduped');
    expect(r.existing).toContain('postmortems');
    // No write
    expect(ctx.memory.read()).toBe(before);
  });

  it('action=conflict does NOT write + returns clarifying question', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- user prefers compact bullet lessons');
    const before = ctx.memory.read();
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({
        action: 'conflict',
        existing: '- user prefers compact bullet lessons',
        proposed: 'user prefers full Context/Why/Rule postmortem structure',
        question: 'You previously preferred compact bullets. Switching to full postmortem structure?',
        reason: 'contradicts existing preference',
      }),
      costUsd: 0.001,
    });
    const r = (await moRememberTool.handler(
      { fact: 'user prefers full Context/Why/Rule postmortem structure' },
      ctx.tc,
    )) as { action: string; question?: string };
    expect(r.action).toBe('conflict');
    expect(r.question).toBeTruthy();
    expect(ctx.memory.read()).toBe(before);
  });

  it('override=true forces a write past a previously-conflicting item', async () => {
    // Regression for the conflict-resolution loop bug
    // (`01KQ2ZZ969G4RCC20C67M5SJV2`): prior implementation had no way
    // to convey "user resolved this" to sub-Mo, so the second call
    // would just return `conflict` again and memory never updated.
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- call user "господин"');
    let promptSeenByMo = '';
    ctx.provider.responseFor = (req) => {
      promptSeenByMo = req.messages[0].content; // system prompt
      return {
        content: JSON.stringify({
          action: 'added',
          body: '## Preferences\n- call user "месье"',
          reason: 'override resolution',
        }),
        costUsd: 0.001,
      };
    };
    const r = (await moRememberTool.handler(
      { fact: 'call user "месье"', override: true },
      ctx.tc,
    )) as { ok: boolean; action: string; afterHash: string; beforeHash: string };
    expect(r.ok).toBe(true);
    expect(r.action).toBe('added');
    expect(r.afterHash).not.toBe(r.beforeHash); // memory rewritten
    expect(ctx.memory.read()).toBe('## Preferences\n- call user "месье"');
    // Sub-Mo MUST receive the OVERRIDE-mode prompt, not the default one
    expect(promptSeenByMo).toContain('OVERRIDE MODE');
    expect(promptSeenByMo).toContain('REMOVE the contradicting line');
  });

  it('override=true rejects sub-Mo returning conflict (contract violation)', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- call user "господин"');
    const before = ctx.memory.read();
    // Sub-Mo ignored the override prompt and returned conflict anyway
    // (small models occasionally disregard strict instructions).
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({
        action: 'conflict',
        existing: '- call user "господин"',
        proposed: 'месье',
        question: 'override?',
        reason: 'still conflicting',
      }),
      costUsd: 0.001,
    });
    const r = (await moRememberTool.handler(
      { fact: 'месье', override: true },
      ctx.tc,
    )) as { error?: string; message?: string };
    expect(r.error).toBe('mo_decision_invalid');
    expect(r.message).toMatch(/override/i);
    // No write happened
    expect(ctx.memory.read()).toBe(before);
  });

  it('override=false (default) preserves the existing conflict-returning behavior', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- existing pref');
    let promptSeenByMo = '';
    ctx.provider.responseFor = (req) => {
      promptSeenByMo = req.messages[0].content;
      return {
        content: JSON.stringify({
          action: 'conflict',
          existing: '- existing pref',
          proposed: 'new pref',
          question: 'switch?',
          reason: 'contradicts',
        }),
        costUsd: 0.001,
      };
    };
    const r = (await moRememberTool.handler(
      { fact: 'new pref' }, // no override
      ctx.tc,
    )) as { action: string };
    expect(r.action).toBe('conflict');
    // Default mode prompt — no OVERRIDE block
    expect(promptSeenByMo).not.toContain('OVERRIDE MODE');
    expect(promptSeenByMo).toContain('Decide ONE of');
  });

  it('redacts secrets in fact BEFORE Mo sees it', async () => {
    activatePro(ctx.tc);
    let factSeenByMo = '';
    ctx.provider.responseFor = (req) => {
      factSeenByMo = req.messages[1].content;
      return {
        content: JSON.stringify({ action: 'added', body: '## x\n- y', reason: 'r' }),
        costUsd: 0.001,
      };
    };
    const r = (await moRememberTool.handler(
      { fact: 'API key sk-test_DEMO_abcdefghijklmnopqrstuvwxyz is the prod key' },
      ctx.tc,
    )) as { warnings?: string[] };
    expect(factSeenByMo).not.toContain('sk-test_DEMO_abcdefghijklmnopqrstuvwxyz');
    expect(factSeenByMo).toContain('[REDACTED');
    expect(r.warnings?.some((w) => /redacted/i.test(w))).toBe(true);
  });

  it('records cost as kind=mo_tool to the existing monthly ledger', async () => {
    activatePro(ctx.tc);
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({ action: 'added', body: '## x\n- y', reason: 'r' }),
      costUsd: 0.0042,
    });
    await moRememberTool.handler({ fact: 'x' }, ctx.tc);
    expect(ctx.ledger.recent(5)).toHaveLength(1);
    expect(ctx.ledger.recent(5)[0].kind).toBe('mo_tool');
    expect(ctx.tc.concierge!.budget.status().spentMonthBreakdown.mo_tool).toBeCloseTo(0.0042, 5);
  });

  it('parse failure returns mo_decision_invalid', async () => {
    activatePro(ctx.tc);
    ctx.provider.responseFor = () => ({ content: 'not json', costUsd: 0.001 });
    const r = (await moRememberTool.handler({ fact: 'x' }, ctx.tc)) as { error?: string };
    expect(r.error).toBe('mo_decision_invalid');
  });
});
