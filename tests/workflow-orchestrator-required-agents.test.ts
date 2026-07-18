import { describe, it, expect } from 'vitest';
import { collectRequiredAgents } from '../src/core/auto-code/workflows/workflow-orchestrator/helpers.js';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';

/**
 * Pin for the required-agents preflight used by admission.ts. The
 * function must mirror `splitAgents` (templates.ts): a cli_agent
 * stage WITH a fallback makes its PRIMARY optional and its FALLBACK
 * required — so a folder on the default template (codex review +
 * claude fallback) is admitted on a machine that only has claude.
 * Regression: the old impl inverted this and rejected such folders
 * with `agent_unavailable`.
 */

// collectRequiredAgents only reads stage.kind / .agent / .fallbackAgent.
function def(stages: Array<Record<string, unknown>>): WorkflowDefinition {
  return { stages } as unknown as WorkflowDefinition;
}

describe('collectRequiredAgents', () => {
  it('default-template shape (claude fix + codex review w/ claude fallback) → requires claude only, NOT codex', () => {
    const req = collectRequiredAgents(
      def([
        { kind: 'cli_agent', id: 'fix', agent: 'claude' },
        {
          kind: 'cli_agent',
          id: 'review',
          agent: 'codex',
          fallbackAgent: 'claude',
        },
      ]),
    );
    expect(req).toContain('claude');
    // codex is a fallback-covered primary → optional, must NOT gate admission.
    expect(req).not.toContain('codex');
  });

  it('a stage without a fallback makes its primary required', () => {
    expect(collectRequiredAgents(def([{ kind: 'cli_agent', id: 'fix', agent: 'pi' }]))).toEqual([
      'pi',
    ]);
  });

  it('a fallback-only agent (its primary covered) is required', () => {
    // Single review stage: codex primary, claude fallback → run can
    // complete on claude, so claude is the required one.
    const req = collectRequiredAgents(
      def([{ kind: 'cli_agent', id: 'review', agent: 'codex', fallbackAgent: 'claude' }]),
    );
    expect(req).toEqual(['claude']);
  });

  it('ignores non-cli_agent stages', () => {
    const req = collectRequiredAgents(
      def([
        { kind: 'mo_stage', id: 'mo_start' },
        { kind: 'cli_agent', id: 'fix', agent: 'claude' },
        { kind: 'human_gate', id: 'gate' },
      ]),
    );
    expect(req).toEqual(['claude']);
  });
});
