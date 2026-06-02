import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from '../theme/ThemeProvider';

/**
 * Auto-code Workflow Builder — visual workflow editor surface.
 *
 * Umbrella ticket: 01KR5F21709BKA6SFHWRFFVVPY.
 * Refactor decomposition: Morion ticket 01KRJYYZ3N5AN2Z5YDAVXBZZ0S.
 *
 * This file is the composition root only. Each concern lives in its
 * own module under ./canvas/:
 *   - types.ts                  — public CanvasDefinition shape.
 *   - marshal.ts                — definition <-> {nodes, edges}.
 *   - stage-factory.ts          — id allocation + default-stage shapes.
 *   - agent-options.ts          — provider/level matrix + kind labels.
 *   - StageNode.tsx             — per-stage xyflow node renderer.
 *   - RoutableEdge.tsx          — label-draggable bezier edge + context.
 *   - CanvasToolbar.tsx         — "+ kind" toolbar (data-driven).
 *   - panels/StagePanel.tsx     — side-panel dispatcher.
 *   - panels/<Kind>Body.tsx     — per-kind side-panel form.
 *   - use-workflow-canvas.ts    — hooks-level state machine + handlers.
 *
 * The runtime is currently linear-only via parseLinearWorkflow; the
 * editor accepts any DAG and the server rejects non-linear shapes at
 * save time ("DAG configurations are L4"). That keeps the editor
 * shippable without coupling to a runner rewrite.
 */

// Re-export the public type surface so existing callers
// (FolderSettingsDialog, AutoCodePopup) keep importing from this file.
export type {
  CanvasAgent,
  CanvasCliAgentStage,
  CanvasMcpToolStage,
  CanvasHumanGateStage,
  CanvasBranchStage,
  CanvasMoRouterStage,
  CanvasEjectStage,
  CanvasMoModelOverride,
  CanvasMoStage,
  CanvasRejectSinkStage,
  CanvasCompleteSinkStage,
  CanvasStage,
  CanvasLayout,
  CanvasDefinition,
} from './canvas/types';

import type { CanvasDefinition } from './canvas/types';
import { NODE_TYPES } from './canvas/StageNode';
import { EDGE_TYPES, EdgeRouteContext } from './canvas/RoutableEdge';
import { CanvasToolbar } from './canvas/CanvasToolbar';
import { StagePanel } from './canvas/panels/StagePanel';
import { useWorkflowCanvas } from './canvas/use-workflow-canvas';

export interface WorkflowCanvasEditorProps {
  definition: CanvasDefinition;
  onChange: (next: CanvasDefinition) => void;
  disabled?: boolean;
  /** Ref the parent can use to read the LATEST marshalled definition
   *  synchronously at save time, bypassing React state altogether.
   *  Lifesaver when state propagation chain doesn't flush in time
   *  (2026-05-11 user report — adding stages didn't persist on save
   *  unless the user also moved a block). The canvas wires this ref
   *  to a closure that runs graphToDefinition on the current xyflow
   *  node/edge state. */
  getLatestRef?: React.MutableRefObject<(() => CanvasDefinition) | null>;
}

export function WorkflowCanvasEditor(props: WorkflowCanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner({
  definition,
  onChange,
  disabled,
  getLatestRef,
}: WorkflowCanvasEditorProps) {
  const canvas = useWorkflowCanvas({ definition, onChange, getLatestRef });

  // xyflow v12 honours the `colorMode` prop to switch the built-in
  // Controls / MiniMap / edges palette to dark surfaces. Default
  // styling has white button backgrounds that "выбиваются" on the
  // dark canvas; threading the app theme keeps them coherent.
  const { theme } = useTheme();

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-2">
      <CanvasToolbar
        onAdd={canvas.addStage}
        disabled={disabled}
        hasRejectSink={canvas.hasRejectSink}
        hasCompleteSink={canvas.hasCompleteSink}
      />
      <div className="relative flex-1 min-h-0 rounded-md border border-border bg-background/40">
        <EdgeRouteContext.Provider value={canvas.edgeRouteCtx}>
          <ReactFlow
            nodes={canvas.nodes}
            edges={canvas.edges}
            onNodesChange={canvas.onNodesChange}
            onEdgesChange={canvas.onEdgesChange}
            onConnect={canvas.onConnect}
            onReconnect={canvas.onReconnect}
            edgesReconnectable={!disabled}
            onSelectionChange={(sel) => {
              canvas.setSelectedId(sel.nodes[0]?.id ?? null);
            }}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            colorMode={theme}
            fitView
            // padding=0.3 + maxZoom=1 keeps newly-rendered graphs at a
            // comfortable readable size instead of slamming a single-
            // stage workflow to 200%.
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
            nodesDraggable={!disabled}
            edgesFocusable={!disabled}
            elementsSelectable={!disabled}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </EdgeRouteContext.Provider>
        {/* Side panel — overlay on the right edge of the canvas
            instead of a grid column. Keeps the canvas full-width when
            no node is selected; floats over the canvas when the user
            opens a stage. */}
        {canvas.selectedStage && (
          <div className="pointer-events-auto absolute right-2 top-2 bottom-2 w-80 max-w-[40%] overflow-y-auto rounded-md border border-border bg-card/95 p-3 shadow-lg backdrop-blur-sm">
            <StagePanel
              stage={canvas.selectedStage}
              onPatch={canvas.onPatchSelected}
              onRemove={canvas.removeSelected}
              canRemove={canvas.canRemoveSelected}
              disabled={disabled}
              onClose={canvas.closeSelected}
            />
          </div>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground">
        Save validates the result as a linear chain today. Add branches
        + human gates for the upcoming DAG runtime; they'll error on
        save until the runner catches up.
      </div>
    </div>
  );
}
