import { useCallback, useEffect, useState } from 'react';
import { skillsApi, type SkillState } from '../../lib/skills';
import { cn } from '../../lib/cn';
import { isTauri } from '../../lib/env';
import { SectionHeader } from './SectionHeader';

// ---------- 3.5. install the morion agent skill ----------

/**
 * Skills section. Surfaces the bundled `morion` skill (English-only
 * SKILL.md + references) and lets the user one-click install it into
 * `~/.claude/skills/morion/` (Claude Code's user-level skills dir).
 * Other clients (Codex CLI / Cursor / Cline / Gemini CLI / Copilot) read
 * the same SKILL.md format from their own paths; for those, surface the
 * bundled file path so a power user can copy the tree manually until the
 * dedicated download flow ships.
 *
 * State machine driven by `skill_get_state` IPC:
 *   - not installed → "Install" primary action
 *   - installed, up-to-date → "Re-install" + "Uninstall" secondaries
 *   - installed, update available, not customised → "Update" primary +
 *     "Uninstall" secondary
 *   - installed, customised → "Update (overwrite my edits)" with confirm
 *     dialog + "Uninstall" secondary; warning text explains the diff
 *   - installed externally (no marker) → "Take over" with confirm
 *
 * In dev/browser mode the IPC bridge is unavailable; the section
 * renders a "desktop-only" placeholder.
 */
export function SkillsSection() {
  const [state, setState] = useState<SkillState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await skillsApi.getState();
      setState(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInstall = useCallback(
    async (force: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        const s = await skillsApi.install(force);
        setState(s);
        setToast(force ? 'Skill reinstalled (overwrote local edits).' : 'Skill installed.');
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const onUninstall = useCallback(async () => {
    if (busy) return;
    if (!window.confirm('Remove the Morion skill from ~/.claude/skills/morion/?')) {
      return;
    }
    setBusy(true);
    try {
      const s = await skillsApi.uninstall();
      setState(s);
      setToast('Skill uninstalled.');
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const onInstallClick = useCallback(() => {
    if (!state) return;
    if (state.customised) {
      if (
        !window.confirm(
          'You have local edits to SKILL.md. Reinstalling will overwrite them. Continue?',
        )
      ) {
        return;
      }
      void onInstall(true);
      return;
    }
    if (state.installedExternally) {
      if (
        !window.confirm(
          'A skill folder already exists at this path but Morion did not install it. Take it over?',
        )
      ) {
        return;
      }
      void onInstall(true);
      return;
    }
    void onInstall(false);
  }, [state, onInstall]);

  return (
    <section>
      <SectionHeader
        title="Agent skills"
        blurb={`SKILL.md is a near-standard format — Claude Code, Codex CLI, Cursor, Cline, Gemini CLI, Copilot all read the same skill body. Pick the matching install option for your agent below.`}
      />

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {/* ----- Claude Code (Tauri-only one-click install) ----- */}
        <li className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              Claude Code
              {isTauri && state?.installed && !state.customised && !state.updateAvailable && !state.installedExternally && (
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  Installed v{state.markerVersion ?? state.installedVersion ?? '?'}
                </span>
              )}
              {isTauri && state?.installed && state.updateAvailable && !state.customised && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  Update available
                </span>
              )}
              {isTauri && state?.installed && state.customised && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  Customised
                </span>
              )}
              {isTauri && state?.installedExternally && (
                <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                  Installed by another tool
                </span>
              )}
              {isTauri && state && !state.installed && state.bundledVersion && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Bundled v{state.bundledVersion}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {isTauri ? (state?.installPath || '~/.claude/skills/morion/') : '~/.claude/skills/morion/'}
            </div>
            {!isTauri && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                One-click install is desktop-only. Use the download button on the right and unzip into the path above.
              </div>
            )}
            {isTauri && state?.installed && state.updateAvailable && state.bundledVersion && (
              <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                Bundle has v{state.bundledVersion}; you're on v{state.markerVersion ?? '?'}.
              </div>
            )}
            {isTauri && state?.customised && (
              <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                Local edits detected — install will prompt before overwriting.
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isTauri && state && (
              <>
                <button
                  type="button"
                  disabled={busy || !state.bundledVersion}
                  onClick={onInstallClick}
                  title={
                    state.bundledVersion
                      ? 'Install / update the Morion skill at ~/.claude/skills/morion/'
                      : 'Bundled skill missing — rebuild the Morion app to include skills/morion/'
                  }
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    state.installed && !state.updateAvailable
                      ? 'border border-border text-muted-foreground hover:bg-accent'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90',
                    (busy || !state.bundledVersion) && 'opacity-50',
                  )}
                >
                  {!state.bundledVersion
                    ? 'Bundle missing'
                    : !state.installed
                    ? 'Install'
                    : state.updateAvailable
                    ? `Update to v${state.bundledVersion ?? '?'}`
                    : 'Re-install'}
                </button>
                {state.installed && !state.installedExternally && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onUninstall}
                    className={cn(
                      'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive',
                      busy && 'opacity-50',
                    )}
                  >
                    Uninstall
                  </button>
                )}
              </>
            )}
            {!isTauri && (
              <a
                href="/api/skills/morion/bundle.zip"
                download="morion-skill.zip"
                className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Download .zip
              </a>
            )}
          </div>
        </li>

        {/* ----- Other agents — universal download ----- */}
        <li className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              Other agents
            </div>
            <div className="text-[11px] text-muted-foreground">
              Codex CLI, Cursor, Cline, Gemini CLI, Copilot, Antigravity — same
              SKILL.md, different install path. Download and unzip into the agent's
              skills directory.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href="/api/skills/morion/bundle.zip"
              download="morion-skill.zip"
              className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Download .zip
            </a>
          </div>
        </li>
      </ul>

      {toast && (
        <div className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground">
          {toast}
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Using a different agent? (Codex CLI, Cursor, Cline, Gemini CLI, Copilot)
        </summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>
            The same SKILL.md works in every modern agent — only the install path
            differs. Until the dedicated downloader ships, copy the bundled tree
            manually:
          </p>
          {state?.bundledPath && (
            <div className="rounded-md bg-muted/50 p-2 font-mono text-[11px] text-foreground">
              {state.bundledPath}
            </div>
          )}
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Codex CLI: copy into <span className="font-mono">~/.codex/skills/morion/</span>
            </li>
            <li>
              Cursor: copy into the project's <span className="font-mono">.cursor/skills/morion/</span>{' '}
              and reference from <span className="font-mono">.cursorrules</span>
            </li>
            <li>
              Cline / Copilot / Gemini CLI / Antigravity: SKILL.md drops into{' '}
              <span className="font-mono">.agents/skills/morion/</span> (project- or user-level
              depending on the tool)
            </li>
          </ul>
        </div>
      </details>
    </section>
  );
}

// ---------- 4. connected clients (audit) ----------
