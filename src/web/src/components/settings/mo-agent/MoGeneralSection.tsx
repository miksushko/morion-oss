import { ComingSoonBadge } from '../leaf';

export function MoGeneralSection() {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">General</h3>
        <p className="mt-1 text-xs text-muted-foreground">How Mo is enabled.</p>
      </div>
      <div className="rounded-md border border-border bg-background/40 p-4 text-xs text-muted-foreground">
        <p>
          Mo enablement is currently{' '}
          <strong className="text-foreground">per-folder</strong> — flip{' '}
          <em>AI access &amp; Mo</em> on inside each folder's settings.
          Workspace-wide Mo runs only when (a) a backend + API key are
          configured below in <em>API &amp; Provider</em>, and (b) at
          least one folder has Mo enabled.
        </p>
        <p className="mt-2 flex items-center gap-2">
          <span>
            A single workspace-wide master toggle for Mo is on the way.
          </span>
          <ComingSoonBadge />
        </p>
        <p className="mt-2">
          Until then, the closest equivalents are: turning off the
          indexing master (<em>Mo Data Indexing</em> section below) and
          clearing the API key (<em>API &amp; Provider</em>).
        </p>
      </div>
    </section>
  );
}
