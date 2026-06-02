import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import { cliAgentStage } from '../helpers/workflow-types-fixtures.js';

describe('cli_agent v2 Agent Status fields (Phase 3)', () => {
  it('accepts cli_agent with all v2 fields populated', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'fully-loaded-cli-agent',
      stages: [
        cliAgentStage('fix', {
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          level: 'Ultrathink',
          agentInstruction:
            'Read CLAUDE.md and tasks/todo.md before writing any code.',
        }),
      ],
      edges: [],
    });
    const stage = parsed.stages[0];
    if (stage.kind !== 'cli_agent') throw new Error('unreachable');
    expect(stage.provider).toBe('anthropic');
    expect(stage.model).toBe('claude-opus-4-7');
    expect(stage.level).toBe('Ultrathink');
    expect(stage.agentInstruction).toMatch(/CLAUDE\.md/);
  });

  it('accepts cli_agent with a subset of v2 fields populated', () => {
    // Per spec: each override field is independently optional — user
    // might want "default everything except level=High".
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'partial-override',
        stages: [cliAgentStage('fix', { level: 'High' })],
        edges: [],
      }),
    ).not.toThrow();
  });
});
