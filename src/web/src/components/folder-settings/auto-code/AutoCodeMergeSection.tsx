import { useState } from 'react';
import { api, type ConciergeFolderSettings } from '../../../lib/api';
import { SwitchRow } from '../../SwitchRow';

/** Auto-merge toggle — when on, finished worktrees merge to trunk
 *  automatically. Mirrors the legacy `AutoMergeSection`. */
export function AutoCodeMergeSection({
  folderId,
  settings,
  onSettingsChange,
  disabled,
}: {
  folderId: string;
  settings: ConciergeFolderSettings;
  onSettingsChange: (next: ConciergeFolderSettings) => void;
  disabled: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.putConciergeFolderSettings(folderId, {
        autoMergeEnabled: next,
      });
      onSettingsChange(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2">
      <SwitchRow
        label="Auto-merge on done"
        hint="When Mo finishes a ticket, merge the worktree branch into main / master automatically. Turn on when you trust auto-code; leave off when you want to review the diff first."
        checked={settings.autoMergeEnabled}
        onChange={(v) => void onToggle(v)}
        disabled={saving || disabled}
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
