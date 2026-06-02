/**
 * Regression: dogfood 2026-05-04 (`Bkt Design System rewrite`).
 *
 * When the user replies to a topic-cleanup escalation via the
 * "Custom instruction" inline editor, chat-tier Mo previously had no
 * structured context about the proposer's pending choices and could
 * hallucinate "Mo is not enabled for this folder" — paraphrasing the
 * `MO_ACCESS_DENIED_NOT_ENABLED` template even though the folder IS
 * Mo-enabled (the cleanup proposer can't run otherwise).
 *
 * Fix: `buildChatSystemPrompt` accepts an optional `cleanupEscalation`
 * block. The route detects custom-instruction replies and populates
 * it from the proposer's `quickActions[].payload`. The prompt block
 * hard-codes "this folder IS Mo-enabled, never claim otherwise".
 */
import { describe, it, expect } from 'vitest';
import {
  buildChatSystemPrompt,
  type CleanupEscalationContext,
} from '../src/core/concierge/prompt.js';

describe('buildChatSystemPrompt — cleanup escalation context', () => {
  it('omits the block when no escalation is passed', () => {
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: 'Bkt Design System rewrite',
    });
    expect(sys).not.toMatch(/Pending topic-cleanup escalation/);
  });

  it('renders a merge-bundle decision with all topics + recommended main', () => {
    const escalation: CleanupEscalationContext = {
      folderName: 'Bkt Design System rewrite',
      decisions: [
        {
          kind: 'merge-bundle',
          topics: ['material-design', 'user-interface-components'],
          recommendedMain: 'material-design',
        },
      ],
    };
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: escalation.folderName,
      cleanupEscalation: escalation,
    });
    expect(sys).toMatch(/Pending topic-cleanup escalation/);
    expect(sys).toContain('Bkt Design System rewrite');
    expect(sys).toContain('material-design');
    expect(sys).toContain('user-interface-components');
    expect(sys).toMatch(/Recommended main: `material-design`/);
    // Both option labels surfaced so Mo can name the right button.
    expect(sys).toMatch(/Use `material-design` as main \(recommended\)/);
    expect(sys).toMatch(/Use `user-interface-components` as main/);
    expect(sys).toMatch(/Keep all separate/);
  });

  it('renders a demote decision with source + suggested tag', () => {
    const escalation: CleanupEscalationContext = {
      folderName: 'Coral Demo',
      decisions: [
        {
          kind: 'demote',
          source: 'customer-issues',
          suggestedTag: 'customer-issues',
        },
      ],
    };
    const sys = buildChatSystemPrompt({
      grumpyMentor: false,
      folderName: 'Coral Demo',
      cleanupEscalation: escalation,
    });
    expect(sys).toMatch(/Demote.*`customer-issues`.*`customer-issues`/);
    expect(sys).toMatch(/Demote to tag `customer-issues`/);
    expect(sys).toMatch(/Keep as topic/);
  });

  it('hard-codes the "Mo IS enabled, never claim otherwise" rule', () => {
    // The whole point of the block — Mo cannot tell the user "Mo is
    // not enabled" when this block is in the prompt, because the
    // cleanup proposer literally cannot run on a Mo-disabled folder.
    const escalation: CleanupEscalationContext = {
      folderName: 'Bkt',
      decisions: [
        {
          kind: 'merge-bundle',
          topics: ['a', 'b'],
          recommendedMain: 'a',
        },
      ],
    };
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: 'Bkt',
      cleanupEscalation: escalation,
    });
    expect(sys).toMatch(/folder `Bkt` IS Mo-enabled/);
    expect(sys).toMatch(/NEVER tell the user "Mo is not enabled/);
    expect(sys).toMatch(/turn on AI Access.*wrong/);
  });

  it('tells Mo there is no chat-tier tool that directly mutates clusters', () => {
    // Without this rule, chat-tier Mo would try `mo_forget` /
    // `mo_remember` to "save" the user's cleanup intent, which
    // silently does nothing cluster-level — UX confusion + budget
    // burn. (`mo_record` was also called out here pre-May-2026;
    // the tool is now disabled.)
    const escalation: CleanupEscalationContext = {
      folderName: 'Bkt',
      decisions: [
        {
          kind: 'merge-bundle',
          topics: ['a', 'b'],
          recommendedMain: 'a',
        },
      ],
    };
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: 'Bkt',
      cleanupEscalation: escalation,
    });
    expect(sys).toMatch(/no chat-tier tool that directly merges/i);
    expect(sys).toMatch(/mo_forget.*mo_remember/);
  });

  it('null folderName falls back to "this folder" wording', () => {
    const escalation: CleanupEscalationContext = {
      folderName: null,
      decisions: [
        {
          kind: 'demote',
          source: 'x',
          suggestedTag: 'x',
        },
      ],
    };
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      cleanupEscalation: escalation,
    });
    expect(sys).toMatch(/Pending topic-cleanup escalation — this folder/);
    expect(sys).toMatch(/this folder IS Mo-enabled/);
  });
});
