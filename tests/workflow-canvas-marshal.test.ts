import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import {
  definitionToGraph,
  graphToDefinition,
  edgeLayoutKey,
  SYNTHETIC_NODE_IDS,
  MO_NODE_ID,
  CANCEL_SINK_ID,
} from '../src/web/src/components/canvas/marshal';
import type { CanvasDefinition } from '../src/web/src/components/canvas/types';

/**
 * Pure-helper coverage for the WorkflowCanvasEditor refactor (Morion
 * ticket 01KRJYYZ3N5AN2Z5YDAVXBZZ0S). Pins the contract before the
 * upcoming UI split + protects future agents from accidentally
 * regressing round-trip behaviour the editor depends on.
 */

const baseDef = (overrides: Partial<CanvasDefinition> = {}): CanvasDefinition => ({
  schemaVersion: 1,
  name: 'wf',
  stages: [],
  edges: [],
  ...overrides,
});

describe('canvas/marshal — edgeLayoutKey', () => {
  it('encodes from / to / on as a stable triple', () => {
    expect(edgeLayoutKey('a', 'b', 'reopen')).toBe('a→b:reopen');
    expect(edgeLayoutKey('a', 'b', '')).toBe('a→b:');
  });
});

describe('canvas/marshal — definitionToGraph', () => {
  it('produces one node per stage and one edge per def.edges entry', () => {
    const def = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        {
          id: 's2',
          kind: 'reject_sink',
        },
      ],
      edges: [{ from: 's1', to: 's2' }],
    });
    const { nodes, edges } = definitionToGraph(def);
    expect(nodes.map((n) => n.id)).toEqual(['s1', 's2']);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 's1', target: 's2' });
  });

  it('routes mo_stage/mo_router edges via sourceHandle = branch label', () => {
    const def = baseDef({
      stages: [
        {
          id: 'router',
          kind: 'mo_stage',
          instruction: '',
          branches: ['approve', 'reject'],
        },
        { id: 'a', kind: 'reject_sink' },
        { id: 'b', kind: 'complete_sink' },
      ],
      edges: [
        { from: 'router', to: 'a', on: 'reject' },
        { from: 'router', to: 'b', on: 'approve' },
      ],
    });
    const { edges } = definitionToGraph(def);
    const byTarget = Object.fromEntries(edges.map((e) => [e.target, e]));
    expect(byTarget.a.sourceHandle).toBe('reject');
    expect(byTarget.b.sourceHandle).toBe('approve');
  });

  it('does NOT set sourceHandle for edges leaving non-routing stages', () => {
    const def = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        { id: 's2', kind: 'reject_sink' },
      ],
      edges: [{ from: 's1', to: 's2', on: '' }],
    });
    const [edge] = definitionToGraph(def).edges;
    expect(edge.sourceHandle).toBeUndefined();
  });

  it('synthesises a dashed reopen edge from cli_agent.verdictPolicy.onReopen', () => {
    const def = baseDef({
      stages: [
        {
          id: 'review',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: '',
          verdictPolicy: { onReopen: { reopenStageId: 'fix' } },
        },
        {
          id: 'fix',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: '',
        },
      ],
    });
    const { edges } = definitionToGraph(def);
    const synth = edges.find((e) => e.id.startsWith('synth_reopen_'));
    expect(synth).toBeDefined();
    expect(synth?.source).toBe('review');
    expect(synth?.target).toBe('fix');
    expect((synth?.data as { synthetic?: boolean }).synthetic).toBe(true);
    expect(synth?.animated).toBe(true);
  });

  it('preserves saved node positions when every node has one (no dagre)', () => {
    const def = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        { id: 's2', kind: 'reject_sink' },
      ],
      layout: {
        nodes: { s1: { x: 123, y: 45 }, s2: { x: 678, y: 90 } },
      },
    });
    const { nodes } = definitionToGraph(def);
    expect(nodes.find((n) => n.id === 's1')?.position).toEqual({ x: 123, y: 45 });
    expect(nodes.find((n) => n.id === 's2')?.position).toEqual({ x: 678, y: 90 });
  });

  it('runs dagre layout when ANY node lacks a saved position', () => {
    const def = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        { id: 's2', kind: 'reject_sink' },
      ],
      edges: [{ from: 's1', to: 's2' }],
      layout: { nodes: { s1: { x: 999, y: 999 } } }, // s2 missing
    });
    const { nodes } = definitionToGraph(def);
    // dagre rewrites s1's position so the saved (999, 999) does NOT
    // survive — pinning the fallback path.
    expect(nodes.find((n) => n.id === 's1')?.position).not.toEqual({ x: 999, y: 999 });
  });

  it('hydrates saved edge control points onto edge.data.cx/cy', () => {
    const def = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        { id: 's2', kind: 'reject_sink' },
      ],
      edges: [{ from: 's1', to: 's2', on: '' }],
      layout: {
        nodes: { s1: { x: 0, y: 0 }, s2: { x: 0, y: 200 } },
        edges: { [edgeLayoutKey('s1', 's2', '')]: { cx: 50, cy: 100 } },
      },
    });
    const { edges } = definitionToGraph(def);
    expect((edges[0].data as { cx?: number; cy?: number }).cx).toBe(50);
    expect((edges[0].data as { cx?: number; cy?: number }).cy).toBe(100);
  });
});

describe('canvas/marshal — graphToDefinition', () => {
  const makeStageNode = (id: string, stage: object, y = 0): Node => ({
    id,
    type: 'stage',
    position: { x: 0, y },
    data: { stage },
  });

  it('orders stages by node Y position', () => {
    const nodes = [
      makeStageNode('top', { id: 'top', kind: 'reject_sink' }, 10),
      makeStageNode(
        'mid',
        { id: 'mid', kind: 'cli_agent', agent: 'claude', promptTemplate: '' },
        50,
      ),
      makeStageNode('bot', { id: 'bot', kind: 'complete_sink' }, 100),
    ];
    const def = graphToDefinition(baseDef({ name: 'x' }), nodes, []);
    expect(def.stages.map((s) => s.id)).toEqual(['top', 'mid', 'bot']);
  });

  it('strips synthetic decoration nodes from the saved stage list', () => {
    const nodes = [
      makeStageNode('real', { id: 'real', kind: 'reject_sink' }, 10),
      // Synthetic decoration node — no data.stage payload
      { id: MO_NODE_ID, type: 'mo_orchestrator', position: { x: 0, y: 5 }, data: {} },
      { id: CANCEL_SINK_ID, type: 'mo_cancelled_sink', position: { x: 0, y: 20 }, data: {} },
    ];
    const def = graphToDefinition(baseDef(), nodes, []);
    expect(def.stages.map((s) => s.id)).toEqual(['real']);
    expect(SYNTHETIC_NODE_IDS.has(MO_NODE_ID)).toBe(true);
  });

  it('strips synthetic edges (synth_reopen + edges touching synthetic nodes)', () => {
    const nodes = [
      makeStageNode('a', { id: 'a', kind: 'cli_agent', agent: 'claude', promptTemplate: '' }, 0),
      makeStageNode('b', { id: 'b', kind: 'reject_sink' }, 50),
    ];
    const edges: Edge[] = [
      { id: 'real', source: 'a', target: 'b', data: { on: '' } },
      { id: 'synth', source: 'a', target: 'b', data: { synthetic: true, on: 'reopen' } },
      { id: 'mo-edge', source: MO_NODE_ID, target: 'b', data: {} },
    ];
    const def = graphToDefinition(baseDef(), nodes, edges);
    expect(def.edges).toEqual([{ from: 'a', to: 'b', on: '' }]);
  });

  it('prunes edges referencing deleted nodes (dangling endpoint guard)', () => {
    const nodes = [
      makeStageNode('a', { id: 'a', kind: 'reject_sink' }, 0),
    ];
    const edges: Edge[] = [
      { id: 'dangling', source: 'a', target: 'ghost', data: {} },
    ];
    const def = graphToDefinition(baseDef(), nodes, edges);
    expect(def.edges).toEqual([]);
  });

  it('persists xyflow sourceHandle → edge.on when user wires a branch handle', () => {
    const nodes = [
      makeStageNode(
        'r',
        {
          id: 'r',
          kind: 'mo_stage',
          instruction: '',
          branches: ['ok', 'no'],
        },
        0,
      ),
      makeStageNode('sink', { id: 'sink', kind: 'reject_sink' }, 50),
    ];
    const edges: Edge[] = [
      { id: 'e', source: 'r', target: 'sink', sourceHandle: 'no', data: {} },
    ];
    const def = graphToDefinition(baseDef(), nodes, edges);
    expect(def.edges).toEqual([{ from: 'r', to: 'sink', on: 'no' }]);
  });

  it('writes layout.nodes from final positions + layout.edges only when cx/cy present', () => {
    const nodes = [
      { ...makeStageNode('a', { id: 'a', kind: 'reject_sink' }, 0), position: { x: 11, y: 22 } } as Node,
      { ...makeStageNode('b', { id: 'b', kind: 'complete_sink' }, 0), position: { x: 33, y: 44 } } as Node,
    ];
    const edges: Edge[] = [
      { id: 'with-ctrl', source: 'a', target: 'b', data: { on: '', cx: 100, cy: 200 } },
      { id: 'no-ctrl', source: 'b', target: 'a', data: { on: '' } },
    ];
    const def = graphToDefinition(baseDef(), nodes, edges);
    expect(def.layout?.nodes).toEqual({
      a: { x: 11, y: 22 },
      b: { x: 33, y: 44 },
    });
    // Only the edge with cx/cy gets a control point entry.
    expect(def.layout?.edges).toEqual({
      [edgeLayoutKey('a', 'b', '')]: { cx: 100, cy: 200 },
    });
  });

  it('omits layout.edges entirely when no edge has a control point', () => {
    const nodes = [
      makeStageNode('a', { id: 'a', kind: 'reject_sink' }, 0),
    ];
    const def = graphToDefinition(baseDef(), nodes, []);
    expect(def.layout?.edges).toBeUndefined();
  });

  it('round-trips definition → graph → definition losslessly for layout-bearing inputs', () => {
    const original = baseDef({
      stages: [
        { id: 's1', kind: 'cli_agent', agent: 'claude', promptTemplate: 'p' },
        { id: 's2', kind: 'reject_sink' },
      ],
      edges: [{ from: 's1', to: 's2', on: '' }],
      layout: {
        nodes: { s1: { x: 0, y: 0 }, s2: { x: 100, y: 200 } },
      },
    });
    const { nodes, edges } = definitionToGraph(original);
    const back = graphToDefinition(original, nodes, edges);
    expect(back.stages).toEqual(original.stages);
    expect(back.edges).toEqual(original.edges);
    expect(back.layout?.nodes).toEqual(original.layout?.nodes);
  });
});
