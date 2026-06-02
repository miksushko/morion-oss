import { useEffect, useRef, useState } from 'react';
import { api, type ConciergeFolderSettings } from '../../../lib/api';

/** Folder-level override for the workflow's `mo_start` intake gate.
 *  Free text, debounced 700ms autosave. Empty = inherit from workflow
 *  template default. Mirrors the legacy `IntakeInstructionSection`. */
export function AutoCodeIntakeSection({
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
  const [draft, setDraft] = useState(settings.intakeInstruction ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFolderId = useRef<string>(folderId);

  useEffect(() => {
    if (lastFolderId.current !== folderId) {
      lastFolderId.current = folderId;
      setDraft(settings.intakeInstruction ?? '');
    }
  }, [folderId, settings.intakeInstruction]);

  const onChange = (next: string) => {
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        setSaving(true);
        setError(null);
        try {
          const updated = await api.putConciergeFolderSettings(folderId, {
            intakeInstruction: next,
          });
          onSettingsChange(updated);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSaving(false);
        }
      })();
    }, 700);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[12px] font-medium">Intake rule (Mo gate)</div>
        <span className="text-[10px] text-muted-foreground/70">
          {saving
            ? 'Saving…'
            : draft.length > 0
              ? 'Custom rule ✓'
              : 'Using workflow default'}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Override the workflow's <code>mo_start</code> decision rule for
        this folder only. Mo reads this verbatim when deciding whether
        to accept or reject a ticket dragged into <code>todo</code>.
        Leave empty to use whatever the selected workflow defines.
      </p>
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        maxLength={4000}
        disabled={disabled}
        placeholder={
          'e.g. "Accept any ticket with a body or comments; reject only empty ones." OR "Reject unless the ticket has explicit acceptance criteria."'
        }
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
