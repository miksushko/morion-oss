import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api, type InstallableClient, type RuntimeInfo } from '../../lib/api';
import { cn } from '../../lib/cn';
import { copyToClipboard } from '../../lib/shareWithLLM';
import { SectionHeader } from './SectionHeader';

// ---------- 3. connect-an-LLM-client ----------

interface ClientSnippet {
  label: string;
  body: string;
}

export function ConnectSection({ runtime }: { runtime: RuntimeInfo | null }) {
  const [clients, setClients] = useState<InstallableClient[] | null>(null);
  const [bundled, setBundled] = useState<boolean>(false);
  const [bundledMessage, setBundledMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listInstallClients();
      setClients(data.clients);
      setBundled(data.bundled);
      setBundledMessage(data.message ?? null);
    } catch (err) {
      setToast(`Failed to load clients: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Surface server errors without the verbose "POST /api/install/X failed:
  // 409: " prefix that the api wrapper bakes in. The server's own message
  // (e.g. "Windsurf is not installed on this machine") is what the user
  // needs to see.
  const cleanError = (err: unknown, displayName: string): string => {
    const raw = (err as Error).message ?? String(err);
    const cleaned = raw.replace(/^[A-Z]+ \/[^\s]+ failed: \d+: ?/, '');
    return cleaned.startsWith(displayName) ? cleaned : `${displayName}: ${cleaned}`;
  };

  const onInstall = useCallback(
    async (id: string, displayName: string) => {
      setBusyId(id);
      try {
        const r = await api.installClient(id);
        setToast(
          `${displayName} connected. Restart it to activate.` +
            (r.backupPath ? ` Backup: ${r.backupPath.split('/').pop()}` : ''),
        );
        await refresh();
      } catch (err) {
        setToast(cleanError(err, displayName));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const onUninstall = useCallback(
    async (id: string, displayName: string) => {
      setBusyId(id);
      try {
        const r = await api.uninstallClient(id);
        setToast(
          `${displayName} disconnected.` +
            (r.backupPath ? ` Backup: ${r.backupPath.split('/').pop()}` : ''),
        );
        await refresh();
      } catch (err) {
        setToast(cleanError(err, displayName));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  // Manual snippet block as fallback for unsupported clients (Zed,
  // Windsurf, anything custom). Reuses the runtime info we already have.
  const fallbackSnippets = useMemo<ClientSnippet[]>(() => {
    if (!runtime) return [];
    let command: string;
    let args: string[];
    let cwd: string | undefined;
    if (runtime.isBundled && runtime.launcherPath) {
      command = runtime.launcherPath;
      args = ['mcp'];
    } else {
      command = 'npm';
      args = ['run', 'mcp'];
      cwd = runtime.cwd;
    }
    const entry = cwd ? { command, args, cwd } : { command, args };
    const generic = { mcpServers: { morion: entry } };
    return [
      {
        label: 'Other clients — generic mcpServers snippet',
        body: JSON.stringify(generic, null, 2),
      },
    ];
  }, [runtime]);

  return (
    <section>
      <SectionHeader
        title="Connect an LLM client"
        blurb="Click Connect to wire Morion into your client's MCP config. Existing entries in the config file are preserved; the original is backed up before any change."
      />
      {!bundled && bundledMessage && (
        <div className="mb-3 rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
          {bundledMessage}
        </div>
      )}
      {clients === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {clients.map((c) => {
            const installed =
              c.status?.kind === 'installed-current' || c.status?.kind === 'installed-stale';
            const malformed = c.status?.kind === 'config-malformed';
            const stale = c.status?.kind === 'installed-stale';
            return (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {c.displayName}
                    {c.status?.kind === 'installed-current' && (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        Connected
                      </span>
                    )}
                    {stale && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Stale — re-install
                      </span>
                    )}
                    {malformed && (
                      <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        Config malformed
                      </span>
                    )}
                  </div>
                  {c.configPath && (
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {c.configPath}
                    </div>
                  )}
                  {malformed && c.status?.kind === 'config-malformed' && (
                    <div className="mt-0.5 text-[11px] text-destructive">{c.status.error}</div>
                  )}
                </div>
                {bundled && !malformed && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => void onInstall(c.id, c.displayName)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        installed
                          ? 'border border-border text-muted-foreground hover:bg-accent'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90',
                        busyId === c.id && 'opacity-50',
                      )}
                    >
                      {installed ? 'Re-install' : 'Connect'}
                    </button>
                    {installed && (
                      <button
                        type="button"
                        disabled={busyId === c.id}
                        onClick={() => void onUninstall(c.id, c.displayName)}
                        className={cn(
                          'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
                          busyId === c.id && 'opacity-50',
                        )}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {toast && (
        <div className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground">
          {toast}
        </div>
      )}
      {fallbackSnippets.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            For unsupported clients — copy a snippet manually
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {fallbackSnippets.map((s) => (
              <SnippetBlock key={s.label} label={s.label} body={s.body} />
            ))}
          </div>
        </details>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium">ChatGPT Desktop</span> is not in the list
        because OpenAI's app doesn't support local stdio MCP servers via a
        config file — it uses OAuth-based Apps/Connectors that require
        server-side registration. If that changes, we'll add it here.
      </p>
    </section>
  );
}

function SnippetBlock({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await copyToClipboard(body);
    setCopied(true);
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [body]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
        {body}
      </pre>
    </div>
  );
}
