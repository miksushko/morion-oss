import { useState } from 'react';
import {
  PointerSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { Note, NoteStatus } from '../../lib/api';
import { resolveDropTarget } from './dnd-resolve';

/**
 * Owns dnd-kit sensors + collision detection + drag handlers + the
 * activeDragId mirror used by `<DragOverlay>`.
 *
 * Collision strategy (ticket 01KPMKZS0TG281YDE3A42QF2HZ — "can't drop
 * into an empty column"): pointerWithin is decisive when cursor is
 * inside a droppable rect; rectIntersection covers brief outside-rect
 * moments during fast drags; closestCorners is the absolute fallback so
 * we never return an empty list.
 */
export function useKanbanDnd(
  columns: Record<NoteStatus, Note[]>,
  onMoveTask: (id: string, status: NoteStatus, after: string | null) => void,
) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const collisionDetection: CollisionDetection = (args) => {
    const pointerHits = pointerWithin(args);
    if (pointerHits.length > 0) return pointerHits;
    const rectHits = rectIntersection(args);
    if (rectHits.length > 0) return rectHits;
    return closestCorners(args);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragOver = () => {
    // Intentional no-op. We resolve the final drop target in handleDragEnd;
    // trying to move cards mid-drag-over causes flicker + stale-index bugs
    // because our notes array is owned by the parent, not local state.
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const result = resolveDropTarget(columns, activeId, overId);
    if (result.kind === 'noop') return;
    onMoveTask(activeId, result.targetStatus, result.afterNoteId);
  };

  return {
    activeDragId,
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  };
}
