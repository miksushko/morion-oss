/**
 * Regression: ticket 01KQ21XVVB7QV20JSE4R7SR1AF — Mo's chat system
 * prompt now caps destructive tool calls at 20 per turn so the
 * chat-loop's MAX_TOOL_TURNS=8 isn't blown by bulk requests like
 * "delete all 150 tags".
 *
 * Pinned at the prompt level: both grumpy and plain variants must
 * carry the cap. Brief-prepended path must still carry it.
 */
import { describe, it, expect } from 'vitest';
import { buildChatSystemPrompt } from '../src/core/concierge/prompt.js';

describe('buildChatSystemPrompt — destructive bulk cap (01KQ21XVVB7QV20JSE4R7SR1AF)', () => {
  it('grumpy variant carries the 10-per-turn cap rule', () => {
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: 'Test',
    });
    expect(sys).toMatch(/Bulk operations/i);
    expect(sys).toMatch(/AT MOST \*\*10\*\*/);
    expect(sys).toMatch(/destructive tool calls/i);
    // Read tools must be explicitly excluded from the cap so Mo
    // doesn't refuse to fetch large lists.
    expect(sys).toMatch(/Read tools.*are NOT capped/i);
    // Server-side enforcement notice so the model knows overshooting
    // costs nothing — it just gets sliced.
    expect(sys).toMatch(/server enforces the same cap/i);
  });

  it('plain variant carries the same cap', () => {
    const sys = buildChatSystemPrompt({
      grumpyMentor: false,
      folderName: null,
    });
    expect(sys).toMatch(/AT MOST \*\*10\*\*/);
    expect(sys).toMatch(/destructive tool calls/i);
  });

  it('cap survives the catalog-prepended path', () => {
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: 'Coral Demo',
      projectCatalog: '# Mo Catalog\n\n- ongoing redesign',
    });
    // Catalog is prepended.
    expect(sys).toMatch(/Mo catalog/);
    expect(sys).toMatch(/ongoing redesign/);
    // Cap rules still present.
    expect(sys).toMatch(/AT MOST \*\*10\*\*/);
  });

  it('cap mentions reporting progress count between batches', () => {
    const sys = buildChatSystemPrompt({
      grumpyMentor: true,
      folderName: null,
    });
    // Mo must surface "X of Y" progress in the assistant text before
    // each batch — the user needs visible state if they interrupt
    // mid-bulk-operation.
    expect(sys).toMatch(/progress count/i);
  });
});
