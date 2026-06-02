import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import { cliAgentStage } from '../helpers/workflow-types-fixtures.js';

describe('Legacy linear workflow backward-compat', () => {
  it('accepts a pure cli_agent linear workflow without v2 sinks (no v2 invariants fire)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'legacy-linear',
        stages: [cliAgentStage('fix'), cliAgentStage('review')],
        edges: [{ from: 'fix', to: 'review', on: 'success' }],
      }),
    ).not.toThrow();
  });

  it('accepts cli_agent stages without the new v2 fields (defaults apply)', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'minimal-cli-agent',
      stages: [cliAgentStage('fix')],
      edges: [],
    });
    const stage = parsed.stages[0];
    expect(stage.kind).toBe('cli_agent');
    if (stage.kind !== 'cli_agent') throw new Error('unreachable');
    // New v2 fields default to NULL / empty string per spec
    // (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1) "Agent Status" semantics:
    // provider/model/level NULL -> adapter default; agentInstruction ''
    // -> no extra user prompt.
    expect(stage.provider).toBeNull();
    expect(stage.model).toBeNull();
    expect(stage.level).toBeNull();
    expect(stage.agentInstruction).toBe('');
  });
});
