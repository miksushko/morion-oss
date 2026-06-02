import { describe, it, expect } from 'vitest';
import {
  CLUSTER_DOC_SECTIONS,
  clusterDocSkeleton,
  parseClusterDoc,
  renderClusterDoc,
  mergeClusterDoc,
  clusterDocHasContent,
  clusterStartMarker,
  clusterEndMarker,
  renderClusterSection,
} from '../src/core/concierge/index.js';

describe('clusterDocSkeleton', () => {
  it('emits all four anchored sections with placeholders', () => {
    const body = clusterDocSkeleton('kanban-ui');
    expect(body).toContain('# Cluster: kanban-ui');
    for (const id of CLUSTER_DOC_SECTIONS) {
      expect(body).toContain(clusterStartMarker(id));
      expect(body).toContain(clusterEndMarker(id));
    }
  });
});

describe('parseClusterDoc', () => {
  it('round-trips a skeleton without drift', () => {
    const original = clusterDocSkeleton('mo-chat-loop');
    const parsed = parseClusterDoc(original);
    const rendered = renderClusterDoc({
      clusterId: 'mo-chat-loop',
      preamble: parsed.preamble,
      sections: parsed.sections,
      trailing: parsed.trailing,
    });
    const reparsed = parseClusterDoc(rendered);
    expect(reparsed.sections).toEqual(parsed.sections);
  });

  it('returns the whole body as preamble when no anchors are present', () => {
    const parsed = parseClusterDoc('# only user prose, no anchors yet');
    expect(parsed.preamble).toBe('# only user prose, no anchors yet');
    for (const id of CLUSTER_DOC_SECTIONS) {
      expect(parsed.sections[id]).toBe('');
    }
  });

  it('preserves trailing user prose after the last anchor', () => {
    const body =
      renderClusterSection('overview', 'Cluster overview text.') +
      '\n\nSome user notes after the last anchor.\n';
    const parsed = parseClusterDoc(body);
    expect(parsed.sections.overview).toBe('Cluster overview text.');
    expect(parsed.trailing).toContain('Some user notes after');
  });

  it('preserves preamble user prose before the first anchor', () => {
    const body =
      '# Custom heading by user\n\nUser intro paragraph.\n\n' +
      renderClusterSection('overview', 'Mo body');
    const parsed = parseClusterDoc(body);
    expect(parsed.preamble).toContain('# Custom heading by user');
    expect(parsed.preamble).toContain('User intro paragraph');
  });
});

describe('mergeClusterDoc', () => {
  it('replaces an anchored section when the LLM provides a non-empty body', () => {
    const current = clusterDocSkeleton('cluster-a');
    const llm = renderClusterSection('overview', 'Updated overview after Tier 2 run.');
    const merged = mergeClusterDoc(current, llm, 'cluster-a');
    const parsed = parseClusterDoc(merged);
    expect(parsed.sections.overview).toBe('Updated overview after Tier 2 run.');
    // Other sections retained their placeholder content.
    expect(parsed.sections.state).toContain('No state recorded yet');
  });

  it('treats an empty LLM section as "no update" (preserves prior content)', () => {
    const current =
      renderClusterSection('overview', 'Existing overview') +
      '\n\n' +
      renderClusterSection('state', 'Existing state');
    const llm =
      renderClusterSection('overview', '') +
      '\n\n' +
      renderClusterSection('state', 'New state from LLM');
    const merged = mergeClusterDoc(current, llm, 'cluster-a');
    const parsed = parseClusterDoc(merged);
    // Empty overview in LLM → existing kept.
    expect(parsed.sections.overview).toBe('Existing overview');
    // Non-empty state in LLM → replaced.
    expect(parsed.sections.state).toBe('New state from LLM');
  });

  it('preserves user prose outside anchors (preamble + trailing) byte-for-byte', () => {
    const current =
      '# Custom heading by user\n\nIntroductory note from user.\n\n' +
      renderClusterSection('overview', 'old overview') +
      '\n\nUser appendix below sections.\n';
    const llm = renderClusterSection('overview', 'new overview');
    const merged = mergeClusterDoc(current, llm, 'cluster-a');
    expect(merged).toContain('# Custom heading by user');
    expect(merged).toContain('Introductory note from user.');
    expect(merged).toContain('User appendix below sections.');
    expect(merged).toContain('new overview');
    expect(merged).not.toContain('old overview');
  });

  it('caps oversized sections by dropping leading lines', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `- bullet ${i}`).join('\n');
    const llm = renderClusterSection('state', big);
    const merged = mergeClusterDoc(clusterDocSkeleton('c'), llm, 'c');
    const parsed = parseClusterDoc(merged);
    expect(parsed.sections.state.length).toBeLessThanOrEqual(8000 + 200); // soft tolerance for trailing newline
    // Tail bullets retained.
    expect(parsed.sections.state).toContain('bullet 1999');
  });
});

describe('clusterDocHasContent', () => {
  it('false for skeleton (placeholders only)', () => {
    expect(clusterDocHasContent(clusterDocSkeleton('cluster-x'))).toBe(false);
  });

  it('true once a real section body is merged', () => {
    const merged = mergeClusterDoc(
      clusterDocSkeleton('cluster-x'),
      renderClusterSection('overview', 'Real content for the cluster.'),
      'cluster-x',
    );
    expect(clusterDocHasContent(merged)).toBe(true);
  });
});
