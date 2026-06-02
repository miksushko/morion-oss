import { describe, expect, it } from 'vitest';
import {
  applyIntakeOverride,
  collapseWorkflowResult,
  extractCostFromData,
} from '../src/server/features/auto-code-factory/helpers.ts';
import { readAutoCodeMonthlyCap } from '../src/server/features/auto-code-factory/settings.ts';
import { AUTO_CODE_MONTHLY_CAP_USD } from '../src/core/concierge/budget.ts';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.ts';

class StubSettings {
  private store: Record<string, unknown> = {};
  set(key: string, value: unknown): void {
    this.store[key] = value;
  }
  get<T>(key: string, defaultValue: T): T {
    return (this.store[key] as T) ?? defaultValue;
  }
}

describe('extractCostFromData', () => {
  it('returns null for non-object inputs', () => {
    expect(extractCostFromData(null)).toBeNull();
    expect(extractCostFromData(undefined)).toBeNull();
    expect(extractCostFromData(42)).toBeNull();
    expect(extractCostFromData('cost')).toBeNull();
    expect(extractCostFromData(true)).toBeNull();
  });

  it('reads `costUsd` first', () => {
    expect(extractCostFromData({ costUsd: 0.12 })).toBe(0.12);
  });

  it('falls back to `spentUsd`', () => {
    expect(extractCostFromData({ spentUsd: 0.05 })).toBe(0.05);
  });

  it('falls back to `totalCostUsd`', () => {
    expect(extractCostFromData({ totalCostUsd: 1.5 })).toBe(1.5);
  });

  it('prefers costUsd over the other shapes', () => {
    expect(
      extractCostFromData({ costUsd: 0.1, spentUsd: 0.2, totalCostUsd: 0.3 }),
    ).toBe(0.1);
  });

  it('returns 0 for explicit zero', () => {
    expect(extractCostFromData({ costUsd: 0 })).toBe(0);
  });

  it('rejects negative numbers', () => {
    expect(extractCostFromData({ costUsd: -0.5 })).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(extractCostFromData({ costUsd: Number.NaN })).toBeNull();
    expect(extractCostFromData({ costUsd: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('rejects non-numeric values for the cost keys', () => {
    expect(extractCostFromData({ costUsd: '0.5' })).toBeNull();
    expect(extractCostFromData({ costUsd: null })).toBeNull();
  });

  it('returns null when no known cost key is present', () => {
    expect(extractCostFromData({ unrelated: 1, foo: 'bar' })).toBeNull();
  });
});

describe('collapseWorkflowResult', () => {
  it('maps an enqueued workflow outcome including deduped flag', () => {
    expect(
      collapseWorkflowResult({ kind: 'enqueued', runId: 'run-1', deduped: true }),
    ).toEqual({
      kind: 'enqueued',
      runId: 'run-1',
      deduped: true,
    });
  });

  it('does not invent deduped when absent on enqueue', () => {
    expect(
      collapseWorkflowResult({ kind: 'enqueued', runId: 'run-2' }),
    ).toEqual({
      kind: 'enqueued',
      runId: 'run-2',
      deduped: undefined,
    });
  });

  it('preserves rejection envelope', () => {
    expect(
      collapseWorkflowResult({
        kind: 'rejected',
        reason: 'auto_code_unavailable',
        missingDetails: ['claude not detected'],
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'auto_code_unavailable',
      missingDetails: ['claude not detected'],
    });
  });
});

describe('applyIntakeOverride', () => {
  const mkDef = (overrides?: Partial<WorkflowDefinition>): WorkflowDefinition =>
    ({
      name: 'test',
      version: 2,
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          isStart: true,
          instruction: 'original instruction',
        } as never,
        {
          id: 'fix',
          kind: 'cli_agent',
          agent: 'claude',
        } as never,
      ],
      ...(overrides ?? {}),
    }) as WorkflowDefinition;

  it('replaces the mo_start instruction when present', () => {
    const def = mkDef();
    const out = applyIntakeOverride(def, 'NEW INSTRUCTION');
    const moStart = out.stages.find((s) => s.id === 'mo_start') as {
      instruction: string;
    };
    expect(moStart.instruction).toBe('NEW INSTRUCTION');
  });

  it('does not mutate the input definition (registry safety)', () => {
    const def = mkDef();
    applyIntakeOverride(def, 'whatever');
    const moStart = def.stages.find((s) => s.id === 'mo_start') as {
      instruction: string;
    };
    expect(moStart.instruction).toBe('original instruction');
  });

  it('leaves non-mo_start stages unchanged', () => {
    const def = mkDef();
    const out = applyIntakeOverride(def, 'NEW');
    const fix = out.stages.find((s) => s.id === 'fix');
    expect(fix).toEqual({ id: 'fix', kind: 'cli_agent', agent: 'claude' });
  });

  it('returns the definition untouched when no mo_start exists (legacy linear)', () => {
    const def = mkDef({
      stages: [{ id: 'fix', kind: 'cli_agent', agent: 'claude' } as never],
    });
    const out = applyIntakeOverride(def, 'IGNORED');
    expect(out).toBe(def);
  });

  it('ignores mo_stage entries that are not the start stage', () => {
    const def = mkDef({
      stages: [
        { id: 'mid', kind: 'mo_stage', isStart: false, instruction: 'mid' } as never,
        { id: 'fix', kind: 'cli_agent', agent: 'claude' } as never,
      ],
    });
    const out = applyIntakeOverride(def, 'NEW');
    expect(out).toBe(def);
  });
});

describe('readAutoCodeMonthlyCap', () => {
  it('returns the workspace default when unset', () => {
    const s = new StubSettings();
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
  });

  it('accepts a finite non-negative number', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', 25);
    expect(readAutoCodeMonthlyCap(s as never)).toBe(25);
  });

  it('accepts 0 as a hard kill-switch', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', 0);
    expect(readAutoCodeMonthlyCap(s as never)).toBe(0);
  });

  it('parses a numeric string', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', '12.5');
    expect(readAutoCodeMonthlyCap(s as never)).toBe(12.5);
  });

  it('falls back on negative number', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', -5);
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
  });

  it('falls back on NaN', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', Number.NaN);
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
  });

  it('falls back on a non-numeric string', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', 'unlimited');
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
  });

  it('falls back on unrelated shapes (boolean, object)', () => {
    const s = new StubSettings();
    s.set('auto_code.monthly_budget_usd', true);
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
    s.set('auto_code.monthly_budget_usd', { value: 10 });
    expect(readAutoCodeMonthlyCap(s as never)).toBe(AUTO_CODE_MONTHLY_CAP_USD);
  });
});
