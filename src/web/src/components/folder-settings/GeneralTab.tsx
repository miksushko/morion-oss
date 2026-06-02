import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { api, type Folder } from '../../lib/api';
import { exportFolderAsMarkdownZip } from '../../lib/exportFolder';
import { SwitchRow } from '../SwitchRow';

/**
 * General tab — folder name, appearance, archive, export. Four
 * independent sections, divider-separated. Each section autosaves on
 * its own — no global Save button. Matches the rest of the app's
 * implicit-save model (Apple Notes style).
 */
export function GeneralTab({
  folder,
  onFolderUpdated,
  onClose,
}: {
  folder: Folder;
  onFolderUpdated: (folder: Folder) => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold">General</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Folder name, view mode, archive status, and export.
        </p>
      </header>

      <FolderNameSection folder={folder} onFolderUpdated={onFolderUpdated} />
      <div className="border-t border-border" />
      <AppearanceSection folder={folder} onFolderUpdated={onFolderUpdated} />
      <div className="border-t border-border" />
      <ArchiveSection
        folder={folder}
        onFolderUpdated={onFolderUpdated}
        onClose={onClose}
      />
      <div className="border-t border-border" />
      <ExportSection folder={folder} />
    </div>
  );
}

/** Folder name — text input with debounced PATCH. Hydrate-once ref so
 *  external updates (e.g. rename from sidebar context menu while the
 *  dialog is open) don't clobber the user's in-flight edits. */
function FolderNameSection({
  folder,
  onFolderUpdated,
}: {
  folder: Folder;
  onFolderUpdated: (folder: Folder) => void;
}) {
  const [draft, setDraft] = useState(folder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hydratedRef.current) {
      setDraft(folder.name);
      hydratedRef.current = true;
    }
  }, [folder.name]);

  useEffect(() => {
    hydratedRef.current = false;
  }, [folder.id]);

  const persist = async (next: string) => {
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === folder.name) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.renameFolder(folder.id, trimmed);
      onFolderUpdated(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onChange = (next: string) => {
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persist(next);
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor="folder-name" className="text-[12px] font-medium">
          Folder name
        </label>
        <span className="text-[10px] text-muted-foreground/70">
          {saving ? 'Saving…' : draft.trim() === folder.name ? 'Saved' : 'Unsaved'}
        </span>
      </div>
      <input
        id="folder-name"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Folder name"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}

/** Appearance — flip between list (folder) and kanban view. Same
 *  setter the sidebar context menu uses. */
function AppearanceSection({
  folder,
  onFolderUpdated,
}: {
  folder: Folder;
  onFolderUpdated: (folder: Folder) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isKanban = folder.viewMode === 'kanban';

  const onToggle = async (nextKanban: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setFolderViewMode(
        folder.id,
        nextKanban ? 'kanban' : 'list',
      );
      onFolderUpdated(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2">
      <SwitchRow
        label="Show as kanban board"
        hint={
          isKanban
            ? 'Cards in columns (backlog · todo · doing · review · done). Drag between columns to change status.'
            : 'Classic list view — notes ordered by edit time, grouped by tags.'
        }
        checked={isKanban}
        onChange={(v) => void onToggle(v)}
        disabled={saving}
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}

/** Archive toggle — flips between live and archived. Archived folders
 *  hide from default views and from MCP; they stay in the DB and can
 *  be revealed via "Show Archived". */
function ArchiveSection({
  folder,
  onFolderUpdated,
  onClose,
}: {
  folder: Folder;
  onFolderUpdated: (folder: Folder) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isArchived = folder.archivedAt !== null;

  const onToggle = async (nextArchived: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const updated = nextArchived
        ? await api.archiveFolder(folder.id)
        : await api.unarchiveFolder(folder.id);
      onFolderUpdated(updated);
      // When the user archives the folder, the parent removes it from
      // the default sidebar list — closing the dialog avoids a stale
      // "settings for invisible folder" surface.
      if (nextArchived) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2">
      <SwitchRow
        label="Archive this folder"
        hint={
          isArchived
            ? 'Folder is archived — hidden from the sidebar and from MCP agents. Mo indexing data is preserved. Turn off to restore.'
            : 'Hide this folder from the default sidebar and from MCP agents. Notes and indexing data are preserved; you can re-enable any time via "Show Archived".'
        }
        checked={isArchived}
        onChange={(v) => void onToggle(v)}
        disabled={saving}
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}

/** Export every live note in the folder as a single `.zip` of `.md`
 *  files. Same helper the sidebar context menu uses. */
function ExportSection({ folder }: { folder: Folder }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onExport = async () => {
    setBusy(true);
    setError(null);
    try {
      await exportFolderAsMarkdownZip(folder.id, folder.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 py-1">
      <div>
        <div className="text-sm font-medium text-foreground">Export</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Download every live note in this folder as a <code>.zip</code> of{' '}
          <code>.md</code> files. Archived and trashed notes are excluded;{' '}
          <code>mo:*</code> system notes are filtered server-side.
        </div>
      </div>
      <button
        type="button"
        onClick={() => void onExport()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        Export as .md (zip)
      </button>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
