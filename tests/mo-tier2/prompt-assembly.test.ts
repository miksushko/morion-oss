import { describe, it, expect } from 'vitest';
import {
  buildTier2Messages,
  clusterDocSkeleton,
} from '../../src/core/concierge/index.js';

describe('buildTier2Messages', () => {
  it('lists every supplied note id verbatim and marks the cluster id', () => {
    const msgs = buildTier2Messages(
      'kanban-ui',
      [
        {
          id: '01NOTE000000000000000000A',
          title: 'Drag broken',
          summary: 'WKWebView dragstart needs setData()',
          keywords: ['drag', 'wk'],
        },
      ],
      clusterDocSkeleton('kanban-ui'),
      undefined,
    );
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('"kanban-ui"');
    expect(msgs[1]!.content).toContain('01NOTE000000000000000000A');
    expect(msgs[1]!.content).toContain('WKWebView dragstart');
  });

  it('embeds house rules verbatim when provided', () => {
    const msgs = buildTier2Messages(
      'cluster-a',
      [{ id: '01A', title: 't', summary: 's', keywords: [] }],
      '',
      'Always cite Lessons aggregator note 01XYZ.',
    );
    expect(msgs[0]!.content).toContain('Always cite Lessons aggregator');
  });
});
