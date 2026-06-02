import type { CanvasDefinition } from '../WorkflowCanvasEditor';

/**
 * Starter shape for the "+ New workflow" sidebar action — a single
 * cli_agent `fix` stage with the prompt template + tools allowlist the
 * legacy seeded default ships with. The user immediately renames it
 * via the sidebar row's edit affordance.
 */
export const EMPTY_DEFINITION: CanvasDefinition = {
  schemaVersion: 1,
  name: 'New workflow',
  description: '',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate:
        'Working on "{{ticket.title}}" ({{ticket.id}}).\n\n{{ticket.body}}',
      maxBudgetUsd: 1,
      maxAttempts: 1,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
  ],
};
