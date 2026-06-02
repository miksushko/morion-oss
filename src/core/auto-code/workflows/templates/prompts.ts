/**
 * Shared Mustache prompt templates for the shipped v2 workflows.
 *
 * Ticket 01KRWRHFAK7HPQYV8GN72BW2VC — "Auto-code: сократить дефолтные
 * процессы до 3-х". The registry now ships three templates:
 *
 *   1. Plan + plan review + code + code review (FULL_PIPELINE)
 *   2. Code + code review (DEFAULT_AUTOCODE_DEFINITION, in
 *      default-autocode.ts)
 *   3. Code only (CODE_ONLY)
 *
 * The legacy per-shape prompts (bug-fix, pi-fix, spike, docs-only)
 * were removed alongside their definitions — users author bespoke
 * flows in the editor.
 */

/** Permissive intake gate — accept-by-default per Editor Model v2
 *  spec ("отправляй в код любой тикет, кроме пустых") + user report
 *  2026-05-11 ("the hardcoded strict gate rejects valid tickets like
 *  Spec: Tetris Training Project"). Per-folder override lives in the
 *  Auto-Code settings panel as `intakeInstruction`; templates ship
 *  with this loose default so the user gets a working pipeline
 *  without editing each stage manually. */
export const PERMISSIVE_START_INSTRUCTION =
  'Read the ticket. Decide "accept" for any ticket that has SOME content to work with — a title plus a body, comments, or any context an autonomous coding agent could act on. Decide "reject" ONLY when the ticket is literally empty. Err on the side of "accept" — the user explicitly dragged this ticket into auto-code and probably wants it tried.';

export const PLAN_PROMPT = [
  'You are planning the implementation of "{{ticket.title}}" ({{ticket.id}}).',
  '',
  'Read the relevant repo files and produce a plan: which files',
  'will change, what new code lives where, what the test surface is.',
  'DO NOT write code — output is the plan only.',
  '',
  'Ticket:',
  '{{ticket.body}}',
  '',
  '--- Recent comments ---',
  '{{ticket.recentComments}}',
  '',
  '{{reopen.reason}}',
].join('\n');

export const PLAN_REVIEW_PROMPT = [
  'Review the implementation plan for "{{ticket.title}}" ({{ticket.id}}).',
  '',
  'Plan from previous stage:',
  '```',
  '{{stages.plan.output.summary}}',
  '```',
  '',
  'Original ticket:',
  '{{ticket.body}}',
  '',
  'Read the affected files yourself to verify the plan\'s assumptions.',
  'Write a short reviewer summary covering:',
  '  - whether the plan covers the acceptance criteria end-to-end',
  '  - missing files / edge cases the plan overlooked',
  '  - architectural concerns that could derail implementation',
  '  - whether the plan is concrete enough to implement (escalate if',
  '    it stays at the "we should think about" level)',
  '',
  'Mo will read your summary and decide approve / reopen / reject — a',
  '"reopen" loops back to the planner with your reasoning.',
].join('\n');

export const IMPLEMENT_PROMPT = [
  'Implement the plan for "{{ticket.title}}" ({{ticket.id}}).',
  '',
  'Plan from previous stage:',
  '```',
  '{{stages.plan.output.summary}}',
  '```',
  '',
  'Plan review notes:',
  '```',
  '{{stages.plan_review.output.summary}}',
  '```',
  '',
  'Original ticket:',
  '{{ticket.body}}',
  '',
  '{{reopen.reason}}',
].join('\n');

export const FEATURE_REVIEW_PROMPT = [
  'Review the implementation of "{{ticket.title}}" against the plan.',
  '',
  'Plan:',
  '```',
  '{{stages.plan.output.summary}}',
  '```',
  '',
  'Implementation summary:',
  '```',
  '{{stages.fix.output.summary}}',
  '```',
  '',
  'Write a short reviewer summary covering:',
  '  - whether the implementation matches the plan',
  '  - gaps or missing test coverage',
  '  - whether the plan itself fits the ticket (escalate if not)',
  '',
  'Mo will read your summary and decide approve / reopen / reject.',
].join('\n');
