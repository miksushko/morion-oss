import { useState } from 'react';
import { Plus, Pencil, Trash2, Tag as TagIcon, ChevronLeft } from 'lucide-react';
import type { Tag } from '../lib/api';
import { TagChip } from '../components/TagChip';
import { ColorPicker } from '../components/ColorPicker';
import { useConfirm } from '../components/ConfirmDialog';
import { cn } from '../lib/cn';

interface Props {
  tags: Tag[];
  onCreate: (name: string, color: string | null) => Promise<Tag>;
  onUpdate: (id: string, patch: { name?: string; color?: string | null }) => Promise<Tag>;
  onDelete: (id: string) => Promise<void>;
  /** Mobile back button — pops the pane stack to the folders pane. Hidden on md+. */
  onMobileBack: () => void;
}

/**
 * Full-width Tag manager screen. Replaces NotesList + EditorPane when the
 * "Tags" nav row is active in the sidebar. Lists every tag with its chip,
 * note count, edit (rename + recolor) and delete actions. Delete uses the
 * shared in-app confirm dialog — the underlying schema uses ON DELETE
 * CASCADE on note_tags so notes themselves are never destroyed.
 */
export function TagManager({ tags, onCreate, onUpdate, onDelete, onMobileBack }: Props) {
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 md:px-8">
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to folders"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Tags</h2>
          <p className="text-xs text-muted-foreground">
            {tags.length} {tags.length === 1 ? 'tag' : 'tags'} in your library
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-accent/40 px-2.5 text-xs font-medium text-foreground transition-all hover:border-ring hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
        >
          <Plus className="h-3.5 w-3.5" />
          New tag
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-4">
        {creating && (
          <TagEditor
            initialName=""
            initialColor={null}
            onSubmit={async (name, color) => {
              await onCreate(name, color);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        {sorted.length === 0 && !creating && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
            <TagIcon className="h-8 w-8 opacity-40" />
            <p className="text-sm">No tags yet.</p>
            <p className="text-xs">
              Tags appear here when you add them to a note, or create them with
              <span className="mx-1 font-medium">+ New tag</span>.
            </p>
          </div>
        )}

        <ul className="divide-y divide-border">
          {sorted.map((t) =>
            editingId === t.id ? (
              <li key={t.id} className="py-3">
                <TagEditor
                  initialName={t.name}
                  initialColor={t.color}
                  onSubmit={async (name, color) => {
                    await onUpdate(t.id, { name, color });
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li
                key={t.id}
                className="group flex items-center justify-between gap-4 py-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <TagChip tag={t} size="lg" />
                  <span className="text-xs text-muted-foreground">
                    {t.noteCount} {t.noteCount === 1 ? 'note' : 'notes'}
                  </span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                  <button
                    type="button"
                    onClick={() => setEditingId(t.id)}
                    aria-label={`Edit ${t.name}`}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete tag "${t.name}"?`,
                        description: 'Notes with this tag stay; only the tag itself goes.',
                        confirmLabel: 'Delete tag',
                        destructive: true,
                      });
                      if (ok) await onDelete(t.id);
                    }}
                    aria-label={`Delete ${t.name}`}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      </div>
    </div>
  );
}

function TagEditor({
  initialName,
  initialColor,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialColor: string | null;
  onSubmit: (name: string, color: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<string | null>(initialColor);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onSubmit(trimmed, color);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4')}>
      <div className="mb-3 flex items-center gap-3">
        <TagChip tag={{ name: name || 'preview', color }} size="lg" />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tag name"
          autoFocus
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={handleSubmit}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
