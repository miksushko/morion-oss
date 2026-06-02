import { describe, it, expect } from 'vitest';
import {
  resolveActiveWorkflowId,
  resolveInitialWorkflowId,
} from '../src/web/src/components/auto-code-popup/select-initial-workflow';
import type { AutoCodeWorkflowSummary } from '../src/web/src/lib/api';

/**
 * Pins the once-only selection-resolution chain the AutoCode popup
 * runs on first open + the sidebar's "default" pill resolution.
 * Refactor (Morion ticket 01KRJZ2FW12N262K6AFD7TC93K) extracts the
 * chain into pure functions to make it testable without rendering
 * the React tree.
 */

const row = (
  id: string,
  overrides: Partial<AutoCodeWorkflowSummary> = {},
): AutoCodeWorkflowSummary =>
  ({
    id,
    folderId: 'f1',
    name: id,
    description: '',
    isDefault: false,
    stageCount: 1,
    agentChain: ['claude'],
    updatedAt: 0,
    createdAt: 0,
    ...overrides,
  }) as AutoCodeWorkflowSummary;

describe('resolveActiveWorkflowId — sidebar default pill', () => {
  it('returns the stored id when it matches a row', () => {
    expect(resolveActiveWorkflowId('w2', [row('w1'), row('w2'), row('w3')])).toBe('w2');
  });

  it('falls back to the isDefault row when stored id is unknown', () => {
    expect(
      resolveActiveWorkflowId('ghost', [row('w1'), row('w2', { isDefault: true })]),
    ).toBe('w2');
  });

  it('falls back to the first row when no isDefault present', () => {
    expect(resolveActiveWorkflowId('', [row('w1'), row('w2')])).toBe('w1');
  });

  it('returns empty string on empty workflow list', () => {
    expect(resolveActiveWorkflowId('w1', [])).toBe('');
  });

  it('handles empty stored id (Free tier / fresh folder) with isDefault fallback', () => {
    expect(
      resolveActiveWorkflowId('', [row('a'), row('b', { isDefault: true })]),
    ).toBe('b');
  });
});

describe('resolveInitialWorkflowId — popup-open selection', () => {
  it('honours an explicit preselected id when it still exists', () => {
    expect(resolveInitialWorkflowId('w2', 'w1', [row('w1'), row('w2'), row('w3')]))
      .toBe('w2');
  });

  it('drops a preselected id that 404d between caller and mount', () => {
    expect(resolveInitialWorkflowId('ghost', 'w1', [row('w1'), row('w2')]))
      .toBe(null);
  });

  it('without a preselect, matches the stored active id', () => {
    expect(resolveInitialWorkflowId(null, 'w2', [row('w1'), row('w2')])).toBe('w2');
  });

  it('falls back to isDefault when stored id is missing or unknown', () => {
    expect(
      resolveInitialWorkflowId(null, 'gone', [
        row('w1'),
        row('w2', { isDefault: true }),
      ]),
    ).toBe('w2');
  });

  it('falls back to the first row when no isDefault present', () => {
    expect(resolveInitialWorkflowId(null, '', [row('w1'), row('w2')])).toBe('w1');
  });

  it('returns null on empty list (popup shows the empty-state body)', () => {
    expect(resolveInitialWorkflowId(null, '', [])).toBe(null);
    expect(resolveInitialWorkflowId('w1', 'w1', [])).toBe(null);
  });

  it('preselect wins over active id when both valid', () => {
    expect(
      resolveInitialWorkflowId('w3', 'w1', [
        row('w1', { isDefault: true }),
        row('w2'),
        row('w3'),
      ]),
    ).toBe('w3');
  });
});
