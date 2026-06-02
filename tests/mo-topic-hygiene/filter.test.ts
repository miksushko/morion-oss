import { describe, it, expect, beforeEach } from 'vitest';
import { filterAgainstDecisions } from '../../src/core/concierge/index.js';
import type { HygieneProposal } from '../../src/core/concierge/index.js';
import { setup, type Ctx } from '../helpers/mo-topic-hygiene-setup.js';

describe('filterAgainstDecisions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('drops pairs already decided + reports them as blocked', () => {
    const folder = ctx.folders.create('F');
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'a',
      targetCluster: 'b',
      decision: 'kept_separate',
      decidedBy: 'user',
    });
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'gen',
      targetCluster: null,
      decision: 'demote_tag',
      decidedBy: 'user',
    });

    const proposal: HygieneProposal = {
      summary: '',
      merges: [
        { source: 'a', target: 'b', confidence: 0.9, reason: '' },
        { source: 'fresh', target: 'newer', confidence: 0.85, reason: '' },
      ],
      demotes: [
        { source: 'gen', suggestedTag: 'g', confidence: 0.9, reason: '' },
        { source: 'okdemote', suggestedTag: 'ok', confidence: 0.9, reason: '' },
      ],
    };

    const out = filterAgainstDecisions(proposal, ctx.decisions, folder.id);
    expect(out.merges).toHaveLength(1);
    expect(out.merges[0]?.source).toBe('fresh');
    expect(out.demotes).toHaveLength(1);
    expect(out.demotes[0]?.source).toBe('okdemote');
    expect(out.blocked).toHaveLength(2);
  });
});
