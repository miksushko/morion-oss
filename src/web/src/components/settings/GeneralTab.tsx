import { useEffect, useState } from 'react';
import { Check, Moon, RefreshCw, RotateCw, Sun } from 'lucide-react';
import { api, type RuntimeInfo } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useTheme } from '../../theme/ThemeProvider';
import type { UpdateCheckResult } from '../UpdateBanner';
import type { UpdateBadge } from './types';
import { SectionDivider, UpdateBadgePill } from './leaf';
import { formatPlatform } from './format';

export function GeneralTab({
  onCheckForUpdates,
  onRefreshData,
  runtime,
}: {
  onCheckForUpdates?: () => Promise<UpdateCheckResult | null | void>;
  onRefreshData?: () => Promise<void>;
  runtime: RuntimeInfo | null;
}) {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h2 className="text-lg font-semibold text-foreground">General</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          App-wide preferences and maintenance.
        </p>
      </header>

      <AboutSection onCheckForUpdates={onCheckForUpdates} runtime={runtime} />
      <SectionDivider />
      <AppearanceSection />
      <SectionDivider />
      <RefreshDataSection onRefreshData={onRefreshData} />
    </div>
  );
}

function AboutSection({
  onCheckForUpdates,
  runtime,
}: {
  onCheckForUpdates?: () => Promise<UpdateCheckResult | null | void>;
  runtime: RuntimeInfo | null;
}) {
  // Version comes from /api/health — single source of truth. Use the
  // auth-aware api.getHealth() helper so the call works in Tauri prod
  // where the sidecar is token-gated.
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [badge, setBadge] = useState<UpdateBadge | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getHealth()
      .then((j) => alive && setVersion(typeof j?.version === 'string' ? j.version : null))
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, []);

  // Auto-clear inline badge after 4s.
  useEffect(() => {
    if (!badge) return;
    const t = setTimeout(() => setBadge(null), 4000);
    return () => clearTimeout(t);
  }, [badge]);

  const handleCheck = async () => {
    if (!onCheckForUpdates) return;
    setChecking(true);
    setBadge(null);
    try {
      const result = await onCheckForUpdates();
      if (result && typeof result === 'object' && 'status' in result) {
        if (result.status === 'available') {
          setBadge({ kind: 'available', version: result.version });
        } else if (result.status === 'up-to-date') {
          setBadge({ kind: 'up-to-date' });
        } else {
          setBadge({ kind: 'unavailable' });
        }
      } else {
        setBadge({ kind: 'done' });
      }
    } catch {
      setBadge({ kind: 'unavailable' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">About</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Current Morion version and update check.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-background/40 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Morion</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Version {version ?? '—'}
          </div>
          {runtime && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/80">
              <span>
                {formatPlatform(runtime.platform)} · {runtime.arch}
              </span>
              <span>{runtime.isBundled ? 'Desktop build' : 'Dev build'}</span>
            </div>
          )}
        </div>
        {onCheckForUpdates && (
          <div className="flex shrink-0 items-center gap-2">
            {badge && <UpdateBadgePill badge={badge} />}
            <button
              type="button"
              onClick={handleCheck}
              disabled={checking}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function AppearanceSection() {
  const { theme, set: setTheme } = useTheme();
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Appearance</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Switch between light and dark theme. Applied immediately.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="inline-flex w-fit rounded-md border border-border p-1"
      >
        <ThemeOption
          icon={<Sun className="h-3.5 w-3.5" />}
          label="Light"
          active={theme === 'light'}
          onClick={() => setTheme('light')}
        />
        <ThemeOption
          icon={<Moon className="h-3.5 w-3.5" />}
          label="Dark"
          active={theme === 'dark'}
          onClick={() => setTheme('dark')}
        />
      </div>
    </section>
  );
}

function ThemeOption({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RefreshDataSection({
  onRefreshData,
}: {
  onRefreshData?: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 4000);
    return () => clearTimeout(t);
  }, [done]);
  const handleRefresh = async () => {
    if (!onRefreshData) return;
    setRefreshing(true);
    setDone(false);
    try {
      await onRefreshData();
      setDone(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Refresh data</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          If you suspect a recent change isn't showing — a note created via
          MCP, a folder updated on another machine — reload notes, folders,
          tags, and trash from the local database. Doesn't re-index,
          doesn't talk to the network.
        </p>
      </div>
      {onRefreshData && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <RotateCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing…' : 'Refresh data'}
          </button>
          {done && (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <Check className="h-3 w-3" />
              Refreshed
            </span>
          )}
        </div>
      )}
    </section>
  );
}
