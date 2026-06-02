import { AlertCircle, ArrowUpRight, Check } from 'lucide-react';
import type { UpdateBadge } from './types';

export function SectionDivider() {
  return <div className="border-t border-border" aria-hidden />;
}

/**
 * "Coming soon" badge — used to flag UI sections that are placeholders
 * for functionality landing in a future release. Vendor-neutral, never
 * references internal ticket ids (those leak roadmap signal to users
 * and bit-rot fast).
 */
export function ComingSoonBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
      Coming soon
    </span>
  );
}

export function UpdateBadgePill({ badge }: { badge: UpdateBadge }) {
  if (badge.kind === 'up-to-date') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <Check className="h-3 w-3" />
        Up to date
      </span>
    );
  }
  if (badge.kind === 'available') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
        <ArrowUpRight className="h-3 w-3" />
        Update available · {badge.version}
      </span>
    );
  }
  if (badge.kind === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive">
        <AlertCircle className="h-3 w-3" />
        Check failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
      <Check className="h-3 w-3" />
      Done
    </span>
  );
}

export function DisabledToggleStub() {
  return (
    <div
      role="switch"
      aria-checked="false"
      aria-disabled="true"
      title="Available once the telemetry implementation lands"
      className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full bg-muted opacity-60"
    >
      <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-background shadow-sm" />
    </div>
  );
}
