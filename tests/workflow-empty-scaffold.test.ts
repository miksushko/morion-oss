import { describe, expect, it } from 'vitest';
import { EMPTY_DEFINITION } from '../src/web/src/components/auto-code-popup/empty-definition.js';
import {
  definitionToGraph,
  graphToDefinition,
} from '../src/web/src/components/canvas/marshal.js';
import { parseDraftWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';

/**
 * New-workflow scaffold validity — bug 01KVJ3G3MQRBN9K7TJ8975RN89.
 *
 * The "+ New workflow" blank scaffold used to be a single bare
 * cli_agent — no Process Start, no sinks — which saved silently but was
 * an invalid v2 shape and gave the user no start/end points. It now
 * seeds a complete valid v2 skeleton. These pins ensure it stays valid
 * (passes the exact save-time schema stack) both as-authored and after
 * a canvas marshal round-trip.
 */

describe('EMPTY_DEFINITION — new-workflow scaffold', () => {
  it('has exactly one Process Start mo_stage + one reject_sink + one complete_sink', () => {
    const starts = EMPTY_DEFINITION.stages.filter(
      (s) => s.kind === 'mo_stage' && s.isStart === true,
    );
    const rejects = EMPTY_DEFINITION.stages.filter(
      (s) => s.kind === 'reject_sink',
    );
    const completes = EMPTY_DEFINITION.stages.filter(
      (s) => s.kind === 'complete_sink',
    );
    expect(starts).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    expect(completes).toHaveLength(1);
  });

  it('passes the save-time v2 validation (parseDraftWorkflow) as authored', () => {
    expect(() =>
      parseDraftWorkflow(EMPTY_DEFINITION as unknown as WorkflowDefinition),
    ).not.toThrow();
  });

  it('still validates after a canvas marshal round-trip (definitionToGraph → graphToDefinition)', () => {
    const { nodes, edges } = definitionToGraph(EMPTY_DEFINITION);
    const roundTripped = graphToDefinition(EMPTY_DEFINITION, nodes, edges);
    expect(() =>
      parseDraftWorkflow(roundTripped as unknown as WorkflowDefinition),
    ).not.toThrow();
    // Round-trip preserves the start + both sinks.
    expect(
      roundTripped.stages.filter(
        (s) => s.kind === 'mo_stage' && (s as { isStart?: boolean }).isStart,
      ),
    ).toHaveLength(1);
    expect(roundTripped.stages.filter((s) => s.kind === 'reject_sink')).toHaveLength(1);
    expect(roundTripped.stages.filter((s) => s.kind === 'complete_sink')).toHaveLength(1);
  });
});
