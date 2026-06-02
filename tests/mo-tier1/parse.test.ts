import { describe, it, expect } from 'vitest';
import { parseTier1Response } from '../../src/core/concierge/index.js';

describe('parseTier1Response', () => {
  it('parses a clean JSON payload', () => {
    const json = JSON.stringify({
      summary: 'A test note about Mo.',
      keywords: ['mo', 'test'],
      cluster_candidates: [{ cluster_id: 'mo-chat-loop', confidence: 0.9 }],
    });
    const out = parseTier1Response(json);
    expect(out).not.toBeNull();
    expect(out!.summary).toBe('A test note about Mo.');
    expect(out!.keywords).toEqual(['mo', 'test']);
    expect(out!.clusterCandidates).toEqual([
      { clusterId: 'mo-chat-loop', confidence: 0.9 },
    ]);
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n' + JSON.stringify({
      summary: 'fenced',
      keywords: [],
      cluster_candidates: [],
    }) + '\n```';
    const out = parseTier1Response(fenced);
    expect(out?.summary).toBe('fenced');
  });

  it('clamps confidence to [0,1]', () => {
    const json = JSON.stringify({
      summary: 's',
      keywords: [],
      cluster_candidates: [
        { cluster_id: 'a', confidence: 5 },
        { cluster_id: 'b', confidence: -2 },
      ],
    });
    const out = parseTier1Response(json);
    expect(out!.clusterCandidates[0]!.confidence).toBe(1);
    expect(out!.clusterCandidates[1]!.confidence).toBe(0);
  });

  it('dedups duplicate cluster ids', () => {
    const json = JSON.stringify({
      summary: 's',
      keywords: [],
      cluster_candidates: [
        { cluster_id: 'a', confidence: 0.9 },
        { cluster_id: 'a', confidence: 0.5 },
      ],
    });
    const out = parseTier1Response(json);
    expect(out!.clusterCandidates).toHaveLength(1);
  });

  it('caps cluster_candidates at 5 items', () => {
    const json = JSON.stringify({
      summary: 's',
      keywords: [],
      cluster_candidates: Array.from({ length: 8 }, (_, i) => ({
        cluster_id: `c${i}`,
        confidence: 0.5,
      })),
    });
    const out = parseTier1Response(json);
    expect(out!.clusterCandidates).toHaveLength(5);
  });

  it('caps keywords at 12 and lowercases them', () => {
    const json = JSON.stringify({
      summary: 's',
      keywords: ['ALPHA', 'Beta', 'gamma', 'Δelta'],
      cluster_candidates: [],
    });
    const out = parseTier1Response(json);
    expect(out!.keywords).toContain('alpha');
    expect(out!.keywords).toContain('beta');
    expect(out!.keywords).not.toContain('ALPHA');
  });

  it('returns null on invalid JSON', () => {
    expect(parseTier1Response('not json at all')).toBeNull();
    expect(parseTier1Response('')).toBeNull();
  });

  it('returns null when summary is missing', () => {
    const json = JSON.stringify({ keywords: [], cluster_candidates: [] });
    expect(parseTier1Response(json)).toBeNull();
  });

  it('handles models that wrap JSON in extra prose', () => {
    const wrapped =
      'Sure, here is the result: ' +
      JSON.stringify({
        summary: 'wrapped',
        keywords: [],
        cluster_candidates: [],
      }) +
      '\nLet me know if you need anything else.';
    const out = parseTier1Response(wrapped);
    expect(out?.summary).toBe('wrapped');
  });
});
