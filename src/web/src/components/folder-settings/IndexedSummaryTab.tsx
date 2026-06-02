import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ConciergeFolderSettings,
  type FolderCatalog,
  type FolderRisks,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { BlockedBanner, MoEnableBanner } from './banners';
import { stripPlaceholder } from './helpers';

/**
 * Indexed Summary tab — combines two pieces the user wanted in one
 * place:
 *
 *   1. The editable `overview` section of the per-folder `mo:catalog`
 *      note (Tier 2.5 output). Mo regenerates on each indexing pass;
 *      user edits land in the catalog note immediately.
 *   2. The Risks read-only feed — catalog `risks` section + Tier 0
 *      high-severity findings. No mutation buttons here (Phase 6.4
 *      owns finding acknowledgement).
 *
 * Owns the tab-level header + the shared blocked / Mo-disabled banners
 * once. The two sections are pure content components — they fetch
 * their own state but don't paint outer chrome.
 */
export function IndexedSummaryTab({
  folderId,
  blockedReason,
  moEnabled,
  canEnableMo,
  savingMo,
  onToggleMo,
}: {
  folderId: string;
  blockedReason: string | null;
  conciergeSettings: ConciergeFolderSettings | null;
  moEnabled: boolean;
  canEnableMo: boolean;
  savingMo: boolean;
  onToggleMo: (next: boolean) => Promise<void>;
  onConciergeUpdated: (next: ConciergeFolderSettings) => void;
}) {
  const tabBlocked = blockedReason !== null;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold">Indexed Summary</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A short durable description of this folder + cross-task risks
          Mo synthesised from recent activity. Both regenerate after
          each indexing pass; the summary is freely editable.
        </p>
      </header>

      {tabBlocked && (
        <BlockedBanner
          reason={blockedReason!}
          hint="Re-enable MCP & Mo Access on Access Permissions to unlock."
        />
      )}
      {!tabBlocked && !moEnabled && (
        <MoEnableBanner
          moEnabled={moEnabled}
          canEnableMo={canEnableMo}
          savingMo={savingMo}
          onToggleMo={onToggleMo}
        />
      )}

      <FolderSummarySection folderId={folderId} />
      <div className="border-t border-border" />
      <FolderRisksSection folderId={folderId} />
    </div>
  );
}

/** Folder Summary — the editable `overview` section of the per-folder
 *  `mo:catalog` note. Mo regenerates on each indexing pass; user edits
 *  land in the catalog note immediately. Header + tab-level banners
 *  live on the parent IndexedSummaryTab. */
function FolderSummarySection({ folderId }: { folderId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FolderCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [overviewDraft, setOverviewDraft] = useState('');
  const [savingOverview, setSavingOverview] = useState(false);
  const overviewHydrated = useRef(false);
  const overviewDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const c = await api.getFolderCatalog(folderId);
      setCatalog(c);
      if (!overviewHydrated.current) {
        setOverviewDraft(stripPlaceholder(c.sections?.overview ?? ''));
        overviewHydrated.current = true;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  }, [folderId]);
  useEffect(() => {
    overviewHydrated.current = false;
    void loadCatalog();
  }, [loadCatalog]);

  const persistOverview = async (next: string) => {
    setSavingOverview(true);
    setError(null);
    try {
      const updated = await api.patchFolderCatalog(folderId, {
        overview: next,
      });
      setCatalog(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingOverview(false);
    }
  };

  const onChangeOverview = (next: string) => {
    setOverviewDraft(next);
    if (overviewDebounce.current) clearTimeout(overviewDebounce.current);
    overviewDebounce.current = setTimeout(() => {
      void persistOverview(next);
    }, 600);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Folder Summary
        </h3>
        <span className="text-[10px] text-muted-foreground/70">
          {savingOverview
            ? 'Saving…'
            : catalog?.catalogNoteId
              ? 'auto · Mo'
              : 'no catalog yet'}
        </span>
      </div>
      <textarea
        id="folder-summary-overview"
        value={overviewDraft}
        onChange={(e) => onChangeOverview(e.target.value)}
        disabled={catalogLoading}
        placeholder={
          catalogLoading
            ? 'Loading folder summary…'
            : "Edit Mo's summary or write your own. Mo regenerates this on the next indexing pass; your edits land in the catalog note immediately."
        }
        className="block min-h-[180px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
      />
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}

/** Risks section — cross-task risks Mo synthesised from recent
 *  activity + deterministic high-severity Tier 0 findings. Read-only.
 *  Header + tab-level banners live on the parent IndexedSummaryTab. */
function FolderRisksSection({ folderId }: { folderId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FolderRisks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void api
      .getFolderRisks(folderId)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [folderId]);

  const catalogRisks = data?.catalog.risks ?? null;
  const findings = data?.findings ?? [];

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Risks
      </h3>

      {loading ? (
        <div className="rounded-md border border-border bg-background/40 p-6 text-center text-sm text-muted-foreground">
          Loading risks…
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium text-muted-foreground">
              Cross-task risks (synthesised)
            </div>
            {catalogRisks ? (
              <div className="rounded-md border border-border bg-background/40 p-3 font-mono text-[12px] leading-relaxed text-foreground whitespace-pre-wrap">
                {catalogRisks}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border bg-background/20 p-3 text-xs italic text-muted-foreground">
                Mo will synthesise cross-task risks once the folder's
                catalog is built. Edit some notes and Mo updates this on
                the next indexing pass.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium text-muted-foreground">
              High-severity findings ({findings.length})
            </div>
            {findings.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-background/20 p-3 text-xs italic text-muted-foreground">
                No p0 or p1 findings open.
              </p>
            ) : (
              <ul className="rounded-md border border-border bg-background/40 divide-y divide-border">
                {findings.map((f) => (
                  <li key={f.id} className="flex items-start gap-2 p-3">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        f.severity === 'p0'
                          ? 'bg-destructive/20 text-destructive'
                          : 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
                      )}
                    >
                      {f.severity}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {f.kind}
                      </div>
                      <div className="text-xs text-foreground">{f.message}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
