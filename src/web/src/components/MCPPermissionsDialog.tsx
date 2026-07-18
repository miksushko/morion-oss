import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { api, type Folder, type Note, type FolderMcpPermissions, type NoteMcpPermissions } from '../lib/api';
import { cn } from '../lib/cn';
import { SwitchRow } from './SwitchRow';

/**
 * Per-folder / per-note MCP access dialog (Morion Pro v0.98+).
 *
 * Pattern: cascading toggles where the master "Visible to AI" gates the
 * sub-toggles. Mutate to allow `update` while disallowing `visible` is
 * incoherent — turning visibility off greys out + zeros the rest. The
 * server enforces the same logic (folder.visible = false short-circuits
 * everything) but the UI prevents users from constructing a contradictory
 * state in the first place.
 *
 * For notes, the model exposes only two modes to the user: "Same as
 * folder" (stores null overrides — the note inherits live, follows folder
 * changes) or "Custom rules" (stores explicit booleans — the note's
 * access is pinned regardless of future folder changes). The old tri-
 * state Allow / Inherit / Deny per-toggle UI was too confusing.
 */

export type DialogTarget =
  | { kind: 'folder'; folder: Folder }
  | { kind: 'note'; note: Note; folder: Folder | null };

interface Props {
  target: DialogTarget;
  /** Called after a successful save with the updated entity. */
  onSaved: (updated: Folder | Note) => void;
  onClose: () => void;
}

export function MCPPermissionsDialog({ target, onSaved, onClose }: Props) {
  // Local state mirrors the persisted values so cancel really cancels.
  const [folderPerms, setFolderPerms] = useState<FolderMcpPermissions>(
    target.kind === 'folder'
      ? target.folder.mcpPermissions
      : { visible: true, create: true, update: true, delete: true },
  );
  const [notePerms, setNotePerms] = useState<NoteMcpPermissions>(
    target.kind === 'note' ? target.note.mcpPermissions : { visible: null, update: null, delete: null },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes the dialog. Match the behaviour of ConfirmDialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'folder') {
        const updated = await api.setFolderPermissions(target.folder.id, folderPerms);
        onSaved(updated);
      } else {
        const updated = await api.setNotePermissions(target.note.id, notePerms);
        onSaved(updated);
      }
      onClose();
    } catch (e) {
      // Strip "PUT /api/foo failed: NNN: " wrapper so the user sees the
      // actual server message.
      const raw = (e as Error).message ?? String(e);
      setError(raw.replace(/^[A-Z]+ \/[^\s]+ failed: \d+: ?/, ''));
    } finally {
      setBusy(false);
    }
  };

  const heading =
    target.kind === 'folder'
      ? `AI access — folder “${target.folder.name}”`
      : `AI access — note “${target.note.title || 'Untitled'}”`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-labelledby="ai-access-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id="ai-access-title" className="text-base font-medium text-foreground">
            {heading}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Choose what AI assistants connected through MCP can do here. Your
          own access in this app is unaffected.
        </p>

        {target.kind === 'folder' ? (
          <FolderToggles perms={folderPerms} onChange={setFolderPerms} />
        ) : (
          <NoteToggles
            perms={notePerms}
            folder={target.folder}
            onChange={setNotePerms}
          />
        )}

        {error && (
          <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Folder-level access toggles. Reused inside FolderSettingsDialog's
 * "Access Permissions" tab — same control surface, different chrome.
 *
 * The master switch is labeled "MCP & Mo Access" because the folder
 * is read by two distinct consumers through the same gate: external
 * MCP agents (Claude Code / Codex / Cursor / etc) AND Mo (the
 * internal indexing + answering agent). Turning this off hides the
 * folder from both, which the description spells out.
 *
 * All controls render as `SwitchRow` (role="switch") so the
 * permissions surface and the Mo enable toggle on the same tab use
 * the same visual primitive.
 */
export function FolderToggles({
  perms,
  onChange,
}: {
  perms: FolderMcpPermissions;
  onChange: (next: FolderMcpPermissions) => void;
}) {
  const subDisabled = !perms.visible;
  return (
    <div className="flex flex-col gap-1">
      <SwitchRow
        label="MCP & Mo Access"
        hint="When off, this folder and its notes are hidden from AI assistants connected via MCP — and from Mo (the in-app indexer & answer agent) regardless of whether AI Data Indexing is on below."
        checked={perms.visible}
        onChange={(v) => onChange({ ...perms, visible: v })}
      />
      <div className={cn('ml-3 mt-1 flex flex-col gap-0.5', subDisabled && 'opacity-40')}>
        <SwitchRow
          label="Allow creating notes"
          checked={perms.create}
          onChange={(v) => onChange({ ...perms, create: v })}
          disabled={subDisabled}
          indent
        />
        <SwitchRow
          label="Allow editing notes"
          checked={perms.update}
          onChange={(v) => onChange({ ...perms, update: v })}
          disabled={subDisabled}
          indent
        />
        <SwitchRow
          label="Allow deleting notes"
          checked={perms.delete}
          onChange={(v) => onChange({ ...perms, delete: v })}
          disabled={subDisabled}
          indent
        />
      </div>
    </div>
  );
}

/**
 * Note-level permissions UX. Two modes:
 *
 *   Same as folder (default) — all three overrides saved as null, so the
 *     note inherits whatever the folder does. If the folder is later
 *     changed, the note follows along.
 *
 *   Custom rules — three checkboxes, prefilled from the current effective
 *     state (note override if set, else folder value, else true for unfiled
 *     notes). Saves explicit booleans — the note "locks in" its choices
 *     regardless of future folder changes.
 *
 * When the note is unfiled (no parent folder), there's nothing to inherit,
 * so we skip the mode radio and show checkboxes directly.
 */
function NoteToggles({
  perms,
  folder,
  onChange,
}: {
  perms: NoteMcpPermissions;
  folder: Folder | null;
  onChange: (next: NoteMcpPermissions) => void;
}) {
  const hasParent = folder !== null;
  const initialMode: 'inherit' | 'custom' = hasParent
    ? perms.visible === null && perms.update === null && perms.delete === null
      ? 'inherit'
      : 'custom'
    : 'custom';
  const [mode, setMode] = useState<'inherit' | 'custom'>(initialMode);

  // Effective values used to prefill checkboxes when the user flips from
  // Same-as-folder to Custom. Read: note override wins, else folder's
  // value, else true (unfiled note defaults to fully accessible).
  const effective = {
    visible: perms.visible ?? folder?.mcpPermissions.visible ?? true,
    update: perms.update ?? folder?.mcpPermissions.update ?? true,
    delete: perms.delete ?? folder?.mcpPermissions.delete ?? true,
  };

  const pickInherit = () => {
    setMode('inherit');
    onChange({ visible: null, update: null, delete: null });
  };
  const pickCustom = () => {
    setMode('custom');
    // Snapshot current effective state into explicit booleans so the
    // checkboxes below render matching values.
    onChange({
      visible: effective.visible,
      update: effective.update,
      delete: effective.delete,
    });
  };

  const fp = folder?.mcpPermissions;
  const folderSummary = fp
    ? [fp.visible && 'View', fp.update && 'Edit', fp.delete && 'Delete']
        .filter(Boolean)
        .join(' · ') || 'Nothing (folder denies all AI access)'
    : null;

  return (
    <div className="flex flex-col gap-3">
      {hasParent && (
        <div className="rounded-md border border-border bg-background/50 p-3 text-[11px] text-muted-foreground">
          In folder <span className="font-medium text-foreground">&ldquo;{folder!.name}&rdquo;</span>
          {folderSummary && (
            <>
              {' '}— folder allows AI to: <span className="text-foreground">{folderSummary}</span>
            </>
          )}
        </div>
      )}

      {hasParent && (
        <div className="flex flex-col gap-1.5">
          <ModeRow
            label="Same as folder"
            description="Use the folder's AI access rules. Best if you want folder changes to apply here too."
            selected={mode === 'inherit'}
            onClick={pickInherit}
          />
          <ModeRow
            label="Custom rules for this note"
            description="Pin this note's AI access independently of the folder."
            selected={mode === 'custom'}
            onClick={pickCustom}
          />
        </div>
      )}

      {mode === 'custom' && (
        <div className={cn('flex flex-col gap-1.5', hasParent && 'ml-4 border-l border-border pl-4')}>
          <Toggle
            label="Allow AI to view"
            checked={perms.visible === true}
            onChange={(v) => onChange({ ...perms, visible: v })}
          />
          <Toggle
            label="Allow AI to edit"
            checked={perms.update === true}
            onChange={(v) => onChange({ ...perms, update: v })}
          />
          <Toggle
            label="Allow AI to delete"
            checked={perms.delete === true}
            onChange={(v) => onChange({ ...perms, delete: v })}
          />
        </div>
      )}
    </div>
  );
}

function ModeRow({
  label,
  description,
  selected,
  onClick,
}: {
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-primary' : 'border-muted-foreground/40',
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-accent', disabled && 'cursor-not-allowed')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>}
      </div>
    </label>
  );
}

