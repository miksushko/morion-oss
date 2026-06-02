import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import {
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('human_gate single-in / single-out (refined v2 spec 2026-05-11)', () => {
  // Human In The Loop is a side-attached text dialog, not a routing
  // node. Exactly one outbound edge — typically loops back to the Mo
  // stage that asked the question so Mo re-evaluates with the user's
  // reply as context. Options field is preserved on the schema for
  // legacy data but ignored by the validator + editor.
  const v2WithHumanGate = (overrides: {
    edges?: Array<{ from: string; to: string; on: string }>;
  }) => ({
    schemaVersion: 1,
    name: 'human-gate',
    stages: [
      moStage('start', { isStart: true }),
      {
        id: 'human',
        kind: 'human_gate',
        prompt: 'Reply in chat with whatever Mo needs to know.',
      },
      rejectSink(),
      completeSink(),
    ],
    // Both terminals reachable: start->human->complete + start->reject.
    edges: overrides.edges ?? [
      { from: 'start', to: 'human', on: 'approve' },
      { from: 'start', to: 'reject', on: 'reject' },
      { from: 'human', to: 'complete', on: 'reply' },
    ],
  });

  it('accepts a human_gate with exactly one outbound edge', () => {
    expect(() => WorkflowDefinitionSchema.parse(v2WithHumanGate({}))).not.toThrow();
  });

  it('rejects a human_gate with no outbound edge (reply has nowhere to go)', () => {
    // 3rd branch 'extra' keeps both terminals reachable so the
    // reachability check doesn't shadow the human_gate-specific
    // single-in/out error we want to surface here.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...v2WithHumanGate({}),
        stages: [
          moStage('start', {
            isStart: true,
            branches: ['approve', 'reject', 'shortcut'],
          }),
          {
            id: 'human',
            kind: 'human_gate',
            prompt: 'Reply.',
          },
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'human', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
          { from: 'start', to: 'complete', on: 'shortcut' },
          // No outbound from human — dead-end.
        ],
      }),
    ).toThrow(/no outbound edge|reply needs somewhere/i);
  });

  it('rejects a human_gate with two outbound edges (single-out by spec)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse(
        v2WithHumanGate({
          edges: [
            { from: 'start', to: 'human', on: 'approve' },
            { from: 'start', to: 'reject', on: 'reject' },
            { from: 'human', to: 'complete', on: 'reply' },
            // Second outbound — should error.
            { from: 'human', to: 'reject', on: 'side-quest' },
          ],
        }),
      ),
    ).toThrow(/single-in \/ single-out|2 outbound edges/i);
  });
});
