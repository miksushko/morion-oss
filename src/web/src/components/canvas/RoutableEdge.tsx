import { createContext, useContext } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';

/**
 * Custom edge with a single user-draggable control point. The label
 * doubles as the drag handle: grabbing it pulls a quadratic-bezier
 * curve through the cursor position.
 *
 * Math note — SVG `Q` bezier hits its midpoint at:
 *   0.25*P0 + 0.5*P1 + 0.25*P2
 * We want the curve's midpoint to LIE at `(cx, cy)` (where the user
 * grabbed the label), so the control point must be:
 *   ctrl = 2*(cx, cy) - 0.5*(source + target)
 *
 * Control points live on `edge.data.cx` / `edge.data.cy` (absolute flow
 * coordinates). graphToDefinition serialises them into
 * `layout.edges[edgeKey].cx/cy` so the user's bent routes persist
 * across save + reload.
 */

/** Context wired by `WorkflowCanvasInner` so the (otherwise stateless)
 *  RoutableEdge can update the parent's edge state during drag AND
 *  signal commit-on-drop. Without this the drag would mutate xyflow's
 *  internal store but never reach the parent's controlled `edges`
 *  state nor `pushUpstream`, so the change neither dirties the editor
 *  nor persists. */
export interface EdgeRouteCtxValue {
  applyRoute: (edgeId: string, cx: number, cy: number) => void;
  commitRoute: () => void;
}

export const EdgeRouteContext = createContext<EdgeRouteCtxValue>({
  applyRoute: () => {},
  commitRoute: () => {},
});

function RoutableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  label,
  style,
  markerEnd,
}: EdgeProps) {
  const { screenToFlowPosition } = useReactFlow();
  const { applyRoute, commitRoute } = useContext(EdgeRouteContext);
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const cx = (data as { cx?: number } | undefined)?.cx ?? midX;
  const cy = (data as { cy?: number } | undefined)?.cy ?? midY;
  const ctrlX = 2 * cx - midX;
  const ctrlY = 2 * cy - midY;
  const path = `M ${sourceX},${sourceY} Q ${ctrlX},${ctrlY} ${targetX},${targetY}`;

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startClient = { x: e.clientX, y: e.clientY };
    const startFlow = screenToFlowPosition(startClient);
    const baseCx = cx;
    const baseCy = cy;
    let moved = false;
    const move = (ev: MouseEvent) => {
      const flow = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const dx = flow.x - startFlow.x;
      const dy = flow.y - startFlow.y;
      moved = true;
      applyRoute(id, baseCx + dx, baseCy + dy);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      // Only push to upstream when the cursor actually moved — a bare
      // click on the label shouldn't dirty the editor.
      if (moved) commitRoute();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label !== undefined && label !== '' && (
        <EdgeLabelRenderer>
          <div
            onMouseDown={onMouseDown}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${cx}px, ${cy}px)`,
              pointerEvents: 'all',
              cursor: 'grab',
              fontSize: 10,
              fontWeight: 500,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'hsl(var(--background) / 0.92)',
              border: '1px solid hsl(var(--border))',
              color: 'hsl(var(--foreground))',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
            title="Drag to bend the edge around other nodes"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const EDGE_TYPES = {
  default: RoutableEdge,
  routable: RoutableEdge,
};
