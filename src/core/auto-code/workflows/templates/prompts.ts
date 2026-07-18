/**
 * Shared Mustache prompt templates for the shipped v2 workflows.
 *
 * Ticket 01KRWRHFAK7HPQYV8GN72BW2VC trimmed the registry from 7
 * near-duplicate (agent-permutation) templates to base SHAPES; the Mo
 * Workflows epic extended it to five
 * flows that differ by STAGE COMPOSITION, not by agent:
 *
 *   1. Plan + plan review + code + code review (FULL_PIPELINE)
 *   2. Code + review + docs + QA (FIX_REVIEW_DOCS_QA)
 *   3. Code + review + docs (FIX_REVIEW_DOCS)
 *   4. Code + code review (DEFAULT_AUTOCODE_DEFINITION, in
 *      default-autocode.ts)
 *   5. Code only (CODE_ONLY)
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
  '--- Previous auto-code runs of this ticket ---',
  '{{ticket.priorRuns}}',
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
  '--- Previous auto-code runs of this ticket ---',
  '{{ticket.priorRuns}}',
  '',
  '{{reopen.reason}}',
].join('\n');

export const DOCS_PROMPT = [
  'You are the documentation agent for "{{ticket.title}}" ({{ticket.id}}).',
  'The implementation is done and reviewed — your job is to bring the',
  "project's documentation in line with what shipped.",
  '',
  'Fix-stage summary:',
  '```',
  '{{stages.fix.output.summary}}',
  '```',
  '',
  'Review-stage summary:',
  '```',
  '{{stages.review.output.summary}}',
  '```',
  '',
  'Files the implementation changed (git diff --stat):',
  '```',
  '{{stages.fix.output.diffstat}}',
  '```',
  '',
  'Read the actual diff in this worktree, then update whatever docs it',
  'touches: README sections, files under docs/, changelogs, user-facing',
  'guides, inline JSDoc on changed public APIs. Keep the edits focused',
  'on THIS change — no drive-by rewrites.',
  '',
  'If the change genuinely affects no documentation, say so plainly at',
  'the top of your output ("NO_DOCS_NEEDED: <one-line reason>") and',
  'exit without editing anything.',
].join('\n');

export const QA_PROMPT = [
  'You are the QA agent for "{{ticket.title}}" ({{ticket.id}}).',
  'Implementation, review, and docs are done — your job is functional',
  'tests that validate the change through the UI.',
  '',
  'Fix-stage summary:',
  '```',
  '{{stages.fix.output.summary}}',
  '```',
  '',
  'Review-stage summary:',
  '```',
  '{{stages.review.output.summary}}',
  '```',
  '',
  'Files the implementation changed (git diff --stat):',
  '```',
  '{{stages.fix.output.diffstat}}',
  '```',
  '',
  'First check how this repo does end-to-end testing (look for',
  'playwright.config.*, cypress.config.*, an e2e/ or tests/e2e dir).',
  '',
  '  - If an e2e framework is set up: write executable specs covering',
  '    the acceptance criteria + the regression-sensitive paths this',
  '    change touches, following the existing spec conventions. Run',
  '    them if the framework allows headless runs.',
  '  - If there is no e2e setup: write a manual functional-test',
  '    checklist as a markdown file next to the existing test docs',
  '    (or under docs/) — concrete steps, expected results, edge cases.',
  '',
  'Do NOT modify application code — tests and test docs only.',
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
  'Files the implementation changed (git diff --stat):',
  '```',
  '{{stages.fix.output.diffstat}}',
  '```',
  '',
  'Write a short reviewer summary covering:',
  '  - whether the implementation matches the plan',
  '  - gaps or missing test coverage',
  '  - whether the plan itself fits the ticket (escalate if not)',
  '',
  'Mo will read your summary and decide approve / reopen / reject.',
].join('\n');
