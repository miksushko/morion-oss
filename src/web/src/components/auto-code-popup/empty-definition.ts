import type { CanvasDefinition } from '../canvas/types';

/**
 * Starter shape for the "+ New workflow" action. A COMPLETE, valid v2
 * graph: Process Start (mo_stage isStart) → fix (cli_agent) → Mo
 * decision → Complete / Reject sinks, fully wired.
 *
 * Bug 01KVJ3G3MQRBN9K7TJ8975RN89: the old scaffold was a single bare
 * cli_agent with no Process Start and no sinks. Because the v2
 * cardinality check only fires once a graph already contains a v2
 * stage, that bare graph saved silently but had no start/end points —
 * and the UI gave no way to add the Process Start. Seeding a valid v2
 * skeleton here means every from-scratch workflow starts with its
 * mandatory start + both terminals already in place and passes save
 * validation immediately; the user just edits the stages.
 *
 * `layout` lays the nodes out left-to-right so the fresh canvas reads
 * as a pipeline instead of a pile at the origin.
 */
export const EMPTY_DEFINITION: CanvasDefinition = {
  schemaVersion: 1,
  name: 'New workflow',
  description: '',
  stages: [
    {
      id: 'mo_start',
      kind: 'mo_stage',
      isStart: true,
      instruction:
        'Read the ticket. Pick "accept" when it has enough content to work on; "reject" only when it is essentially empty.',
      branches: ['accept', 'reject'],
      postComment: true,
      allowedTools: [],
    },
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
    {
      id: 'mo_after_fix',
      kind: 'mo_stage',
      instruction:
        'Read the fix-stage summary. Pick "complete" when it produced a usable diff; "reject" when it failed or produced nothing.',
      branches: ['complete', 'reject'],
      postComment: true,
      allowedTools: [],
    },
    {
      id: 'complete_terminal',
      kind: 'complete_sink',
      commentTemplate: '',
    },
    {
      id: 'reject_terminal',
      kind: 'reject_sink',
      commentTemplate: '',
    },
  ],
  edges: [
    { from: 'mo_start', to: 'fix', on: 'accept' },
    { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
    { from: 'fix', to: 'mo_after_fix', on: 'success' },
    { from: 'mo_after_fix', to: 'complete_terminal', on: 'complete' },
    { from: 'mo_after_fix', to: 'reject_terminal', on: 'reject' },
  ],
  layout: {
    nodes: {
      mo_start: { x: 40, y: 160 },
      fix: { x: 300, y: 160 },
      mo_after_fix: { x: 560, y: 160 },
      complete_terminal: { x: 840, y: 80 },
      reject_terminal: { x: 840, y: 260 },
    },
  },
};
