import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import type { CanvasDefinition, CanvasStage } from './types';
import {
  SYNTHETIC_NODE_IDS,
  definitionToGraph,
  graphToDefinition,
} from './marshal';
import {
  createDefaultStage,
  isStagePinned,
  newStageId,
  readBranches,
} from './stage-factory';
import type { EdgeRouteCtxValue } from './RoutableEdge';

/**
 * Single-hook home for the WorkflowCanvasEditor state machine.
 *
 *  - Owns nodes / edges / selectedId.
 *  - Hydrates from the incoming `definition` and pushes upstream via
 *    `onChange` on every stable mutation.
 *  - Wires the synchronous `getLatestRef` escape hatch so the parent's
 *    save closure can read the latest marshalled definition without
 *    waiting on React state propagation (root cause of the 2026-05-11
 *    "added stages didn't persist on save" bug).
 *  - Handles every xyflow event the canvas listens to: nodes-change
 *    (with dangling-edge pruning on node delete), edges-change,
 *    connect, reconnect — each propagating sourceHandle → edge.on so
 *    Mo branch labels survive the wire.
 *  - Owns the EdgeRouteContext value used by RoutableEdge for
 *    label-drag → commit-on-drop persistence.
 *  - Exposes the add / patch / remove mutators called by the toolbar
 *    + side panel.
 *  - Computes the pinned-singleton + delete-guard flags consumed by
 *    CanvasToolbar + StagePanel.
 */

export interface UseWorkflowCanvasArgs {
  definition: CanvasDefinition;
  onChange: (next: CanvasDefinition) => void;
  getLatestRef?: React.MutableRefObject<(() => CanvasDefinition) | null>;
}

export interface UseWorkflowCanvasResult {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | null;
  selectedStage: CanvasStage | null;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  onReconnect: (oldEdge: Edge, newConn: Connection) => void;
  setSelectedId: (id: string | null) => void;
  addStage: (kind: CanvasStage['kind']) => void;
  onPatchSelected: (patch: Partial<CanvasStage>) => void;
  removeSelected: () => void;
  /** Deselect through xyflow + clear local state. Needed because
   *  bare setSelectedId(null) leaves xyflow's internal selection
   *  state stuck — the next click on the same node would be a no-op. */
  closeSelected: () => void;
  edgeRouteCtx: EdgeRouteCtxValue;
  hasRejectSink: boolean;
  hasCompleteSink: boolean;
  canRemoveSelected: boolean;
}

export function useWorkflowCanvas({
  definition,
  onChange,
  getLatestRef,
}: UseWorkflowCanvasArgs): UseWorkflowCanvasResult {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastDefRef = useRef<CanvasDefinition | null>(null);

  // Mirror nodes / edges into refs so the parent's onSave can read the
  // LATEST graph state synchronously without waiting on React state
  // propagation.
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const definitionRef = useRef<CanvasDefinition>(definition);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    definitionRef.current = definition;
  }, [definition]);
  useEffect(() => {
    if (!getLatestRef) return;
    getLatestRef.current = () =>
      graphToDefinition(
        definitionRef.current,
        nodesRef.current,
        edgesRef.current,
      );
    return () => {
      if (getLatestRef.current) getLatestRef.current = null;
    };
  }, [getLatestRef]);

  // Hydrate from the incoming definition once + whenever the parent
  // resets it (e.g. tab switch from JSON → Visual). Compare by identity
  // to avoid clobbering in-canvas edits when our own onChange
  // propagates back through props.
  useEffect(() => {
    if (definition === lastDefRef.current) return;
    const { nodes: n, edges: e } = definitionToGraph(definition);
    setNodes(n);
    setEdges(e);
    lastDefRef.current = definition;
  }, [definition]);

  const pushUpstream = useCallback(
    (n: Node[], e: Edge[]) => {
      const next = graphToDefinition(definition, n, e);
      lastDefRef.current = next;
      onChange(next);
    },
    [definition, onChange],
  );

  // RoutableEdge label-drag plumbing. The edge component lives at
  // module scope so it can't reach the parent's setEdges / pushUpstream
  // directly — provide both via context. `applyRoute` updates the
  // controlled `edges` state during drag (per-frame); `commitRoute`
  // pushes the result upstream once on drop.
  const edgeRouteCtx = useMemo<EdgeRouteCtxValue>(
    () => ({
      applyRoute: (edgeId, cx, cy) => {
        setEdges((curr) =>
          curr.map((edge) =>
            edge.id === edgeId
              ? { ...edge, data: { ...(edge.data ?? {}), cx, cy } }
              : edge,
          ),
        );
      },
      commitRoute: () => {
        pushUpstream(nodesRef.current, edgesRef.current);
      },
    }),
    [pushUpstream],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((curr) => {
        const next = applyNodeChanges(changes, curr);
        // Don't push position-only drags upstream until the drag ends
        // — xyflow emits a `position` change per frame which would re-
        // render the dialog every frame. xyflow flips `dragging` to
        // false on drop; that's our serialize signal.
        const stableChange = changes.some(
          (c) =>
            c.type === 'add' ||
            c.type === 'remove' ||
            (c.type === 'position' && c.dragging === false),
        );
        // Sibling fix to graphToDefinition's defensive endpoint filter:
        // when xyflow removes a node it does NOT auto-prune edges that
        // still reference it. Without this, the canvas keeps showing a
        // dangling line + the next save trips the schema's
        // `edge.to "<id>" does not match any stage id` 422.
        const removeIds = changes
          .filter(
            (c): c is Extract<NodeChange, { type: 'remove' }> =>
              c.type === 'remove',
          )
          .map((c) => c.id);
        let effectiveEdges = edges;
        if (removeIds.length > 0) {
          const removed = new Set(removeIds);
          const survivingIds = new Set(next.map((n) => n.id));
          const pruned = edges.filter(
            (e) =>
              !removed.has(e.source) &&
              !removed.has(e.target) &&
              survivingIds.has(e.source) &&
              survivingIds.has(e.target),
          );
          if (pruned.length !== edges.length) {
            setEdges(pruned);
            effectiveEdges = pruned;
          }
        }
        if (stableChange) pushUpstream(next, effectiveEdges);
        return next;
      });
    },
    [edges, pushUpstream],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((curr) => {
        const next = applyEdgeChanges(changes, curr);
        pushUpstream(nodes, next);
        return next;
      });
    },
    [nodes, pushUpstream],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((curr) => {
        // For mo_router source handles xyflow passes the branch label
        // as `sourceHandle`; carry it onto the edge so the saved `on`
        // value matches the branch the user wired. Agent stages don't
        // have labeled handles → sourceHandle is null → edge.on stays
        // empty.
        const branch = conn.sourceHandle ?? '';
        const next = addEdge(
          {
            ...conn,
            id: `e_${Date.now()}_${conn.source}_${conn.target}_${branch || 'edge'}`,
            type: 'default',
            label: branch || undefined,
            data: { on: branch },
          },
          curr,
        );
        pushUpstream(nodes, next);
        return next;
      });
    },
    [nodes, pushUpstream],
  );

  /** Edge reconnection (drag an edge endpoint onto a different node /
   *  handle). Mirrors onConnect's sourceHandle → on propagation so
   *  dragging an mo_stage's outbound edge to a new target keeps the
   *  branch label intact. */
  const onReconnect = useCallback(
    (oldEdge: Edge, newConn: Connection) => {
      setEdges((curr) => {
        const branch = newConn.sourceHandle ?? '';
        const next = reconnectEdge(
          oldEdge,
          {
            ...newConn,
            label: branch || undefined,
            data: { on: branch },
          },
          curr,
        );
        pushUpstream(nodes, next);
        return next;
      });
    },
    [nodes, pushUpstream],
  );

  const addStage = (kind: CanvasStage['kind']) => {
    const usedIds = new Set(nodes.map((n) => n.id));
    const id = newStageId(kind, usedIds, nodes.length);
    const hasExistingStart = nodes.some((n) => {
      const s = (n.data as { stage?: CanvasStage } | undefined)?.stage;
      return s?.kind === 'mo_stage' && s.isStart === true;
    });
    const stage = createDefaultStage(kind, { id, hasExistingStart });
    const newNode: Node = {
      id,
      type: 'stage',
      position: { x: 100, y: 100 + nodes.length * 30 },
      data: { stage },
    };
    const next = [...nodes, newNode];
    setNodes(next);
    pushUpstream(next, edges);
    setSelectedId(id);
  };

  const onPatchSelected = (patch: Partial<CanvasStage>) => {
    if (!selectedId) return;
    setNodes((curr) => {
      const prevStage =
        (curr.find((n) => n.id === selectedId)?.data as
          | { stage?: CanvasStage }
          | undefined)?.stage ?? null;
      const next = curr.map((n) => {
        if (n.id !== selectedId) {
          // Mutual exclusion for the Process Start marker: promoting
          // the selected mo_stage to isStart clears it on every other
          // mo_stage, so the schema's "exactly one isStart" invariant
          // always holds (bug 01KVJ3G3MQRBN9K7TJ8975RN89 — there was no
          // UI to move the start; now the MoStageBody toggle does).
          if (patch.isStart === true) {
            const other = (n.data as { stage?: CanvasStage } | undefined)
              ?.stage;
            if (other && other.kind === 'mo_stage' && other.isStart) {
              return { ...n, data: { stage: { ...other, isStart: false } } };
            }
          }
          return n;
        }
        const stage = (n.data as { stage: CanvasStage }).stage;
        const merged = { ...stage, ...patch } as CanvasStage;
        // If the user renamed the stage id, update the node id + patch
        // any edges that referenced it.
        if (patch.id && patch.id !== n.id) {
          return { ...n, id: patch.id, data: { stage: merged } };
        }
        return { ...n, data: { stage: merged } };
      });
      const renamed = patch.id && patch.id !== selectedId;

      // Branch-label rename sync for mo_stage / mo_router. Without
      // this, editing "approve" → "ok" in the side panel leaves the
      // existing outbound edge.on='approve' dangling; schema's
      // superRefine refuses to save the workflow with the "edge.on …
      // is not a declared branch" error. Detect a positional rename
      // (same-length branches array with diffs at specific indices)
      // and rewrite matching outbound edges. The textarea fires per-
      // keystroke patches; this handler is idempotent — intermediate
      // mistakes self-correct on the next keystroke because the edge
      // label updates in lock-step with the branches array.
      const oldBranches = readBranches(prevStage);
      const newBranches = readBranches({
        ...(prevStage ?? {}),
        ...patch,
      } as CanvasStage);
      let edgesAfterBranchRename = edges;
      if (
        oldBranches &&
        newBranches &&
        oldBranches.length === newBranches.length
      ) {
        const renameMap = new Map<string, string>();
        for (let i = 0; i < oldBranches.length; i++) {
          if (
            oldBranches[i] !== newBranches[i] &&
            newBranches[i].length > 0
          ) {
            renameMap.set(oldBranches[i], newBranches[i]);
          }
        }
        if (renameMap.size > 0) {
          edgesAfterBranchRename = edges.map((e) => {
            if (e.source !== selectedId) return e;
            const currentLabel =
              (e.data as { on?: string } | undefined)?.on ??
              (typeof e.label === 'string' ? e.label : '');
            const targetLabel = renameMap.get(currentLabel);
            if (!targetLabel) return e;
            return {
              ...e,
              label: targetLabel,
              data: { ...(e.data ?? {}), on: targetLabel },
            };
          });
        }
      }

      let updatedEdges = edgesAfterBranchRename;
      if (renamed) {
        updatedEdges = updatedEdges.map((e) => ({
          ...e,
          source: e.source === selectedId ? patch.id! : e.source,
          target: e.target === selectedId ? patch.id! : e.target,
        }));
      }
      const edgesChanged = updatedEdges !== edges;
      if (edgesChanged) {
        setEdges(updatedEdges);
        if (renamed) setSelectedId(patch.id ?? null);
      }
      pushUpstream(next, edgesChanged ? updatedEdges : edges);
      return next;
    });
  };

  // Count real (non-synthetic) stage nodes so the delete guard reflects
  // user-authored stages.
  const realStageCount = nodes.filter(
    (n) => !SYNTHETIC_NODE_IDS.has(n.id),
  ).length;

  const stageKindCount = (kind: CanvasStage['kind']): number =>
    nodes.filter((n) => {
      if (SYNTHETIC_NODE_IDS.has(n.id)) return false;
      const stage = (n.data as { stage?: CanvasStage } | undefined)?.stage;
      return stage?.kind === kind;
    }).length;
  const hasRejectSink = stageKindCount('reject_sink') > 0;
  const hasCompleteSink = stageKindCount('complete_sink') > 0;

  const removeSelected = () => {
    if (!selectedId) return;
    if (realStageCount <= 1) return;
    const selectedNodeNow = nodes.find((n) => n.id === selectedId);
    const selectedStageNow = selectedNodeNow
      ? (selectedNodeNow.data as { stage: CanvasStage }).stage
      : null;
    if (isStagePinned(selectedStageNow)) return;
    const nextNodes = nodes.filter((n) => n.id !== selectedId);
    const nextEdges = edges.filter(
      (e) => e.source !== selectedId && e.target !== selectedId,
    );
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedId(null);
    pushUpstream(nextNodes, nextEdges);
  };

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const selectedStage = selectedNode
    ? (selectedNode.data as { stage: CanvasStage }).stage
    : null;
  const canRemoveSelected =
    realStageCount > 1 && !isStagePinned(selectedStage);

  const closeSelected = () => {
    // Dispatch a deselect to xyflow so the node's selected ring clears
    // (and the next click on the same node re-fires onSelectionChange
    // instead of being collapsed as "already selected, no-op"). Bare
    // setSelectedId(null) leaves xyflow's internal selection state
    // stuck.
    if (selectedId) {
      onNodesChange([{ id: selectedId, type: 'select', selected: false }]);
    }
    setSelectedId(null);
  };

  return {
    nodes,
    edges,
    selectedId,
    selectedStage,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onReconnect,
    setSelectedId,
    addStage,
    onPatchSelected,
    removeSelected,
    closeSelected,
    edgeRouteCtx,
    hasRejectSink,
    hasCompleteSink,
    canRemoveSelected,
  };
}
