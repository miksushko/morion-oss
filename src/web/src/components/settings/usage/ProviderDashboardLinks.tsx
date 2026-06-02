import { ExternalLink } from 'lucide-react';
import { PROVIDER_DASHBOARDS } from './usage-meta';

export function ProviderDashboardLinks() {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/30 p-3">
      <div className="text-[11px] text-muted-foreground">
        Cross-check against your provider's dashboard for source-of-truth
        billing. Local ledger is informational — provider numbers always
        win for invoicing.
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {PROVIDER_DASHBOARDS.map((p) => (
          <a
            key={p.provider}
            href={p.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {p.label}
            <ExternalLink className="h-3 w-3" />
          </a>
        ))}
      </div>
    </div>
  );
}
