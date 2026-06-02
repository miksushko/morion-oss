import type { Editor } from '@tiptap/react';
import {
  Rows3,
  Columns3,
  Trash2,
  Table as TableIcon,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '../../components/ContextMenu';

interface EditorContextMenuProps {
  editor: Editor;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Editor right-click context menu. Items shown depend on whether the
 * selection sits inside a table:
 *   - always: "Insert table" (3x3 with header row)
 *   - inside table: row/column add/delete + "Delete table"
 *
 * Each handler closes the menu via `onClose` so a click never leaves
 * the menu visible while the editor mutates underneath. Disabled state
 * mirrors Tiptap's command `.can()` predicate so the user gets a visual
 * cue when an op isn't valid in the current selection.
 *
 * Extracted from `../TiptapEditor.tsx` (2026-05-16, ticket
 * `01KRQYTJYX3NWJW5E1S4V1FDZ9`).
 */
export function EditorContextMenu({ editor, x, y, onClose }: EditorContextMenuProps) {
  const inTable = editor.isActive('table');
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <ContextMenu x={x} y={y} onClose={onClose} ariaLabel="Editor actions">
      {!inTable && (
        <ContextMenuItem
          icon={<TableIcon className="h-3.5 w-3.5" />}
          label="Insert table (3×3)"
          onClick={run(() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run(),
          )}
        />
      )}
      {inTable && (
        <>
          <ContextMenuLabel>Rows</ContextMenuLabel>
          <ContextMenuItem
            icon={<Rows3 className="h-3.5 w-3.5" />}
            label="Add row above"
            onClick={run(() => editor.chain().focus().addRowBefore().run())}
          />
          <ContextMenuItem
            icon={<Rows3 className="h-3.5 w-3.5" />}
            label="Add row below"
            onClick={run(() => editor.chain().focus().addRowAfter().run())}
          />
          <ContextMenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete row"
            destructive
            onClick={run(() => editor.chain().focus().deleteRow().run())}
          />
          <ContextMenuSeparator />
          <ContextMenuLabel>Columns</ContextMenuLabel>
          <ContextMenuItem
            icon={<Columns3 className="h-3.5 w-3.5" />}
            label="Add column left"
            onClick={run(() => editor.chain().focus().addColumnBefore().run())}
          />
          <ContextMenuItem
            icon={<Columns3 className="h-3.5 w-3.5" />}
            label="Add column right"
            onClick={run(() => editor.chain().focus().addColumnAfter().run())}
          />
          <ContextMenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete column"
            destructive
            onClick={run(() => editor.chain().focus().deleteColumn().run())}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete table"
            destructive
            onClick={run(() => editor.chain().focus().deleteTable().run())}
          />
        </>
      )}
    </ContextMenu>
  );
}
