import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';
import type { CanvasDefinition, CanvasLayout, CanvasStage } from './types';

/**
 * Pure marshalling layer between `CanvasDefinition` (persisted shape) and
 * xyflow's `{nodes, edges}` runtime model.
 *
 * Two responsibilities:
 *   1. `definitionToGraph` — hydration: produce nodes/edges with stable ids,
 *      labeled source handles on Mo routing nodes, synthesised reopen
 *      arrows from cli_agent verdictPolicy, and a dagre auto-layout
 *      fallback when the saved layout is incomplete.
 *   2. `graphToDefinition` — serialisation: strip synthetic decoration
 *      nodes/edges, prune dangling edges (xyflow removes nodes but not
 *      their edges), and write a `CanvasLayout` map keyed by stable
 *      identifiers so user-arranged positions persist across save+reload.
 */

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 90;

/** Shared style for every xyflow `<Handle>` in the canvas so input + output
 *  dots render at the SAME visual size regardless of position (Top / Bottom
 *  / Left / Right) or kind (single / multi-out / target). 10px square —
 *  bigger than xyflow's default 6-8px so trackpad drags catch the target,
 *  but not so big it dominates the node visually. */
export const HANDLE_STYLE: React.CSSProperties = { width: 10, height: 10 };

/** Stable ids for synthetic decoration nodes — kept ONLY for filter-on-save
 *  backward compat: a canvas saved before the v2 Editor Model redesign may
 *  still surface these ids through round-trip, so graphToDefinition strips
 *  them defensively. NEW canvases never render them. */
export const MO_NODE_ID = '__mo_orchestrator__';
export const CANCEL_SINK_ID = '__mo_cancelled__';
export const SYNTHETIC_NODE_IDS = new Set([MO_NODE_ID, CANCEL_SINK_ID]);

export function layoutNodes(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 90 });
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return p ? { ...n, position: { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 } } : n;
  });
}

/** Stable edge key for the layout map. Same triple graphToDefinition uses
 *  when writing layout.edges so re-hydration finds the stored control
 *  point even if React Flow regenerates edge ids between renders. */
export function edgeLayoutKey(from: string, to: string, on: string): string {
  return `${from}→${to}:${on}`;
}

export function definitionToGraph(def: CanvasDefinition): {
  nodes: Node[];
  edges: Edge[];
} {
  const savedNodePositions = def.layout?.nodes ?? {};
  const savedEdgePositions = def.layout?.edges ?? {};
  const stageNodes: Node[] = (def.stages ?? []).map((stage, idx) => {
    const saved = savedNodePositions[stage.id];
    return {
      id: stage.id,
      type: 'stage',
      // Saved position wins; fall back to a vertical column that dagre
      // will lay out below.
      position: saved ?? { x: 0, y: idx * (NODE_HEIGHT + 60) },
      data: { stage },
    };
  });
  // Detect multi-out routing stages — mo_router / mo_stage. These pin
  // outbound edges to a named source handle matching the branch label.
  // human_gate is intentionally NOT in this set: per the refined v2 spec
  // Human In The Loop is single-out, a text dialog that hands control
  // back to a downstream Mo stage.
  const decisionSources = new Set(
    (def.stages ?? [])
      .filter((s) => s.kind === 'mo_router' || s.kind === 'mo_stage')
      .map((s) => s.id),
  );
  const edges: Edge[] = (def.edges ?? []).map((e, idx) => {
    const on = e.on ?? '';
    const savedCtrl = savedEdgePositions[edgeLayoutKey(e.from, e.to, on)];
    return {
      id: `e_${idx}_${e.from}_${e.to}_${on || 'edge'}`,
      source: e.from,
      sourceHandle: decisionSources.has(e.from) && on ? on : undefined,
      target: e.to,
      label: on || undefined,
      type: 'default',
      data: savedCtrl ? { on, cx: savedCtrl.cx, cy: savedCtrl.cy } : { on },
    };
  });

  // Synthesise verdict-policy edges so the user sees the actual business
  // flow: reviewer's reopen routes back to the fix stage. These are NOT
  // in def.edges — they're encoded inside verdictPolicy on the reviewer
  // stage. Marked synthetic so graphToDefinition strips them on save
  // (the loop lives on verdictPolicy, not edges[]).
  //
  // Under v2 reopen is a real edge from `mo_after_review` to `fix` —
  // verdictPolicy is a pre-v2 mechanism. The synth-reopen block stays
  // for backward-compat with legacy linear templates the user hasn't
  // re-seeded yet.
  for (const stage of def.stages ?? []) {
    if (stage.kind !== 'cli_agent') continue;
    const policy = stage.verdictPolicy;
    if (!policy?.onReopen) continue;
    edges.push({
      id: `synth_reopen_${stage.id}_${policy.onReopen.reopenStageId}`,
      source: stage.id,
      target: policy.onReopen.reopenStageId,
      label: 'reopen',
      type: 'default',
      animated: true,
      style: { strokeDasharray: '4 4' },
      data: { synthetic: true, on: 'reopen' },
    });
  }

  // Skip dagre relayout when EVERY stage already has a saved position —
  // preserves the user's drag arrangement across saves. When ANY stage
  // is missing a coordinate (new stage just added, first hydration
  // before save) we run dagre on the whole graph so the new node gets
  // placed sensibly.
  const everyNodeHasSavedPos = stageNodes.every(
    (n) => savedNodePositions[n.id] !== undefined,
  );
  const laidNodes = everyNodeHasSavedPos
    ? stageNodes
    : layoutNodes(stageNodes, edges);
  return { nodes: laidNodes, edges };
}

export function graphToDefinition(
  base: CanvasDefinition,
  nodes: Node[],
  edges: Edge[],
): CanvasDefinition {
  // Filter out synthetic decoration nodes. They're never part of
  // def.stages. Defensive: also drop any node missing a `data.stage`
  // payload.
  const realNodes = nodes.filter(
    (n) =>
      !SYNTHETIC_NODE_IDS.has(n.id) &&
      (n.data as { stage?: CanvasStage } | undefined)?.stage !== undefined,
  );
  // Preserve in-canvas Y-order so a linear-shaped graph round-trips with
  // stages in the order the user actually arranged them.
  const sorted = realNodes.slice().sort((a, b) => a.position.y - b.position.y);
  // Strip synthetic edges (verdictPolicy reopens, legacy Mo dispatch
  // arrows). Drop edges referencing nodes that no longer survive —
  // xyflow node-delete leaves dangling edges in state; saving those
  // crashes with a 422 "edge.to <id> does not match any stage id" since
  // the schema's superRefine validates edge endpoints.
  const realStageIds = new Set(realNodes.map((n) => n.id));
  const realEdges = edges.filter(
    (e) =>
      !(e.data as { synthetic?: boolean } | undefined)?.synthetic &&
      !SYNTHETIC_NODE_IDS.has(e.source) &&
      !SYNTHETIC_NODE_IDS.has(e.target) &&
      realStageIds.has(e.source) &&
      realStageIds.has(e.target),
  );
  // Marshal positions + edge control points into the layout map so the
  // user's arrangement persists across save + reload. Keyed by stable
  // identifiers (stage id for nodes, from→to:on for edges) — React
  // Flow's internal node/edge ids can churn between renders but stage
  // ids are user-authored.
  const layoutNodesMap: Record<string, { x: number; y: number }> = {};
  for (const n of realNodes) {
    layoutNodesMap[n.id] = { x: n.position.x, y: n.position.y };
  }
  const layoutEdgesMap: Record<string, { cx: number; cy: number }> = {};
  for (const e of realEdges) {
    const ed = e.data as { on?: string; cx?: number; cy?: number } | undefined;
    if (ed?.cx === undefined || ed?.cy === undefined) continue;
    const on = e.sourceHandle ?? ed.on ?? '';
    layoutEdgesMap[edgeLayoutKey(e.source, e.target, on)] = {
      cx: ed.cx,
      cy: ed.cy,
    };
  }
  const layout: CanvasLayout = {
    nodes: layoutNodesMap,
    ...(Object.keys(layoutEdgesMap).length > 0
      ? { edges: layoutEdgesMap }
      : {}),
  };
  return {
    ...base,
    stages: sorted.map((n) => (n.data as { stage: CanvasStage }).stage),
    edges: realEdges.map((e) => ({
      from: e.source,
      to: e.target,
      // Edge label persistence priority:
      //   1. xyflow's `sourceHandle` (set when the user drags from a
      //      labeled mo_router branch handle) — that's the branch the
      //      ticket follows at runtime.
      //   2. `data.on` (preserved from older / hand-edited JSON) —
      //      keeps round-trip stable.
      //   3. Empty string — agent edges have no semantic label.
      on:
        e.sourceHandle ??
        (e.data as { on?: string } | undefined)?.on ??
        '',
    })),
    layout,
  };
}
