import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * KanbanCardModal — ClickUp-style centered popup for opening a kanban card.
 *
 * Supersedes the previous KanbanDrawer (slide-in from left). Rationale from
 * the dogfooding round: when the user clicks a card they expect their focus
 * to go to the card, not for chrome to shift sideways. A dimmed backdrop +
 * centered dialog makes the focus shift explicit. The board underneath stays
 * visible through the translucent backdrop, so spatial context isn't lost.
 *
 * Shape: fixed overlay, backdrop-blur + bg-black/40. Dialog capped at
 * max-w-3xl + max-h-[88vh] to leave a comfortable strip of board visible
 * on any screen. Children fill the dialog content area — the parent injects
 * the header (status control + close) and body (editor).
 *
 * Dismiss: Escape, backdrop click, or explicit close button in the header.
 * Background scroll is locked while open so wheel events inside the dialog
 * don't bleed into the kanban grid.
 */
export interface KanbanCardModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Optional header slot rendered above the children. Typical contents:
   * status segmented control on the left, close button on the right. */
  header?: ReactNode;
  /** Optional right-side panel (Direction Q — activity + comments).
   *  When present the dialog body becomes a flex row: editor on the
   *  left, panel on the right. The panel is responsible for its own
   *  width; the editor takes the remaining flex-1. */
  sidePanel?: ReactNode;
}

export function KanbanCardModal({
  open,
  onClose,
  header,
  children,
  sidePanel,
}: KanbanCardModalProps) {
  // Escape dismiss. Gated on `open` so we don't leak listeners; bubble phase
  // is fine because the editor inside the dialog doesn't swallow Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock background scroll while open (Apple Notes parity — wheel in a
  // dialog shouldn't scroll the board).
  useEffect(() => {
    if (!open) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      role="presentation"
    >
      {/* Dimmed backdrop. Absolute so the dialog can sit centered above it. */}
      <button
        type="button"
        aria-label="Close card"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Note editor"
        className={cn(
          // min-h-[560px] caps an empty / short card at a usable editing
          // surface — otherwise a blank card collapses to ~80px and feels
          // broken. max-h-[88vh] leaves a strip of board visible on any
          // screen. Viewport fallback `min(560px, 88vh)` handles the rare
          // sub-600px screens where min could otherwise exceed max.
          //
          // Width bumps when a sidePanel is present: editor stays at its
          // usual ~768px comfortable reading column, the panel adds its
          // own ~320px, so the dialog needs ~1120px total. Without the
          // bump the panel carves out of the editor width instead of
          // adding to it (which is what it LOOKS like it should do).
          'relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl',
          sidePanel ? 'max-w-[1120px]' : 'max-w-3xl',
        )}
        style={{
          minHeight: 'min(560px, 88vh)',
          maxHeight: '88vh',
        }}
      >
        {/* Optional header — hosts status control + close button. Parent
            passes it as a slot so this component stays dumb about the
            kanban schema. */}
        {header !== undefined ? (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <div className="min-w-0 flex-1">{header}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close card"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          // No header slot → still render a close button in the top-right
          // corner so the modal always has an explicit dismiss affordance.
          <button
            type="button"
            onClick={onClose}
            aria-label="Close card"
            className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Flex context for children — EditorPane's header/body/footer rely
            on a flex-col parent to push the footer to the bottom regardless
            of body length. When a sidePanel is present, editor + panel
            share the row via an outer flex-row wrapper, and EACH gets its
            own flex-col context so the invariant holds on both sides. */}
        {sidePanel ? (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
            {sidePanel}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
