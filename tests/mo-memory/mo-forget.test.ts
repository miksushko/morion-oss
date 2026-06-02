import { describe, it, expect, beforeEach } from 'vitest';
import { moForgetTool } from '../../src/server/tools/index.js';
import { activatePro, setup, type Ctx } from '../helpers/mo-memory-setup.js';

describe('mo_forget', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('rejects when neither all nor pattern provided', async () => {
    activatePro(ctx.tc);
    const r = (await moForgetTool.handler({}, ctx.tc)) as { error?: string };
    expect(r.error).toBe('mo_invalid_input');
  });

  it('rejects when BOTH all and pattern provided', async () => {
    activatePro(ctx.tc);
    const r = (await moForgetTool.handler({ all: true, pattern: 'foo' }, ctx.tc)) as {
      error?: string;
    };
    expect(r.error).toBe('mo_invalid_input');
  });

  it('all:true wipes the entire memory body (deterministic, no LLM call)', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- foo\n- bar\n\n## Decisions\n- baz');
    const before = ctx.memory.read();
    expect(before.length).toBeGreaterThan(0);
    const r = (await moForgetTool.handler({ all: true }, ctx.tc)) as {
      ok: boolean;
      mode: string;
      removed: string[];
      beforeHash: string;
      afterHash: string;
    };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('all');
    expect(r.removed[0]).toContain('foo');
    expect(r.afterHash).not.toBe(r.beforeHash);
    expect(ctx.memory.read()).toBe('');
    // Deterministic path → no provider call fired
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('all:true on already-empty memory is a no-op (same hashes, no provider call)', async () => {
    activatePro(ctx.tc);
    expect(ctx.memory.read()).toBe('');
    const r = (await moForgetTool.handler({ all: true }, ctx.tc)) as {
      ok: boolean;
      removed: string[];
      beforeHash: string;
      afterHash: string;
    };
    expect(r.ok).toBe(true);
    expect(r.beforeHash).toBe(r.afterHash);
    expect(r.removed).toEqual([]);
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('pattern path: sub-Mo rewrites memory dropping matched lines', async () => {
    activatePro(ctx.tc);
    ctx.memory.write(
      '## Preferences\n- call user "месье"\n- terse responses\n\n## Decisions\n- prefer DuckDB over ClickHouse',
    );
    const before = ctx.memory.read();
    let promptSeen = '';
    ctx.provider.responseFor = (req) => {
      promptSeen = req.messages[0].content;
      return {
        content: JSON.stringify({
          body: '## Preferences\n- terse responses\n\n## Decisions\n- prefer DuckDB over ClickHouse',
          removed: ['- call user "месье"'],
          reason: 'Removed form-of-address per pattern.',
        }),
        costUsd: 0.001,
      };
    };
    const r = (await moForgetTool.handler({ pattern: 'form of address' }, ctx.tc)) as {
      ok: boolean;
      mode: string;
      removed: string[];
      beforeHash: string;
      afterHash: string;
    };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('pattern');
    expect(r.removed).toEqual(['- call user "месье"']);
    expect(r.afterHash).not.toBe(r.beforeHash);
    expect(ctx.memory.read()).not.toContain('месье');
    expect(ctx.memory.read()).toContain('terse responses');
    // Sub-Mo got the existing-memory + pattern context
    expect(promptSeen).toContain('месье');
    expect(promptSeen).toContain('REMOVE items');
    void before;
  });

  it('pattern path: same body returned → no write, hashes unchanged', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- something');
    const before = ctx.memory.read();
    ctx.provider.responseFor = () => ({
      content: JSON.stringify({
        body: before, // sub-Mo keeps everything (pattern matched nothing)
        removed: [],
        reason: 'No matches.',
      }),
      costUsd: 0.001,
    });
    const r = (await moForgetTool.handler({ pattern: 'unrelated' }, ctx.tc)) as {
      ok: boolean;
      removed: string[];
      beforeHash: string;
      afterHash: string;
    };
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual([]);
    expect(r.beforeHash).toBe(r.afterHash);
    expect(ctx.memory.read()).toBe(before);
  });

  it('pattern path on empty memory: short-circuit, no LLM call', async () => {
    activatePro(ctx.tc);
    expect(ctx.memory.read()).toBe('');
    const r = (await moForgetTool.handler({ pattern: 'anything' }, ctx.tc)) as {
      ok: boolean;
      removed: string[];
    };
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual([]);
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('is registered as a delete-category tool (chat path requires approval)', async () => {
    expect(moForgetTool.category).toBe('delete');
    expect(moForgetTool.annotations?.destructiveHint).toBe(true);
  });

  it('parse failure on pattern path returns mo_decision_invalid', async () => {
    activatePro(ctx.tc);
    ctx.memory.write('## P\n- x');
    ctx.provider.responseFor = () => ({ content: 'garbled non-json', costUsd: 0.001 });
    const r = (await moForgetTool.handler({ pattern: 'p' }, ctx.tc)) as { error?: string };
    expect(r.error).toBe('mo_decision_invalid');
  });
});
