import { useCallback, useEffect, useState } from 'react';
import {
  SHIPPED_SKILLS,
  skillsApi,
  type ShippedSkillName,
  type SkillState,
} from '../../lib/skills';
import { cn } from '../../lib/cn';
import { isTauri } from '../../lib/env';
import { SectionHeader } from './SectionHeader';

// ---------- 3.5. install the bundled agent skills ----------

/** Display copy per shipped skill — order comes from SHIPPED_SKILLS. */
const SKILL_BLURBS: Record<ShippedSkillName, string> = {
  morion:
    'Memory, notes, and kanban workflow — the core skill for any agent talking to Morion.',
  'morion-workflows':
    'Auto-code workflow authoring — build, validate, and install WorkflowDefinition JSON via MCP. Load it only when setting up coding pipelines.',
};

/**
 * One install card per shipped skill. Each card owns its own IPC state
 * machine (see skill_get_state docs in `src-tauri/src/skills.rs`):
 *   - not installed → "Install" primary action
 *   - installed, up-to-date → "Re-install" + "Uninstall" secondaries
 *   - installed, update available, not customised → "Update" primary
 *   - installed, customised → confirm-overwrite prompt
 *   - installed externally (no marker) → "Take over" with confirm
 *
 * In dev/browser mode the IPC bridge is unavailable; the card renders
 * the download-zip affordance instead.
 */
function SkillCard({ name }: { name: ShippedSkillName }) {
  const [state, setState] = useState<SkillState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await skillsApi.getState(name);
      setState(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInstall = useCallback(
    async (force: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        const s = await skillsApi.install(force, name);
        setState(s);
        setToast(force ? 'Skill reinstalled (overwrote local edits).' : 'Skill installed.');
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, name],
  );

  const onUninstall = useCallback(async () => {
    if (busy) return;
    if (!window.confirm(`Remove the ${name} skill from ~/.claude/skills/${name}/?`)) {
      return;
    }
    setBusy(true);
    try {
      const s = await skillsApi.uninstall(name);
      setState(s);
      setToast('Skill uninstalled.');
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, name]);

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
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {name}
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
        <div className="text-[11px] text-muted-foreground">{SKILL_BLURBS[name]}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {isTauri ? (state?.installPath || `~/.claude/skills/${name}/`) : `~/.claude/skills/${name}/`}
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
        {error && (
          <div className="mt-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {error}
          </div>
        )}
        {toast && (
          <div className="mt-1 text-[11px] text-muted-foreground">{toast}</div>
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
                  ? `Install / update the ${name} skill at ~/.claude/skills/${name}/`
                  : `Bundled skill missing — rebuild the Morion app to include skills/${name}/`
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
        <a
          href={`/api/skills/${name}/bundle.zip`}
          download={`${name}-skill.zip`}
          className={cn(
            'inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium',
            isTauri
              ? 'border border-border text-muted-foreground hover:bg-accent'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          Download .zip
        </a>
      </div>
    </li>
  );
}

/**
 * Skills section. Surfaces every bundled skill (English-only SKILL.md +
 * references) with one-click install into `~/.claude/skills/<name>/`
 * (Claude Code's user-level skills dir). Other clients (Codex CLI /
 * Cursor / Cline / Gemini CLI / Copilot) read the same SKILL.md format
 * from their own paths — the per-card zip download covers them.
 */
export function SkillsSection() {
  return (
    <section>
      <SectionHeader
        title="Agent skills"
        blurb={`SKILL.md is a near-standard format — Claude Code, Codex CLI, Cursor, Cline, Gemini CLI, Copilot all read the same skill body. One-click install targets Claude Code; every card also offers a zip for other agents.`}
      />

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {SHIPPED_SKILLS.map((name) => (
          <SkillCard key={name} name={name} />
        ))}
      </ul>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Using a different agent? (Codex CLI, Cursor, Cline, Gemini CLI, Copilot)
        </summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>
            The same SKILL.md works in every modern agent — only the install path
            differs. Download the zip from the card above and unzip into your
            agent's skills directory:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Codex CLI: <span className="font-mono">~/.codex/skills/&lt;name&gt;/</span>
            </li>
            <li>
              Cursor: the project's <span className="font-mono">.cursor/skills/&lt;name&gt;/</span>{' '}
              referenced from <span className="font-mono">.cursorrules</span>
            </li>
            <li>
              Cline / Copilot / Gemini CLI / Antigravity: SKILL.md drops into{' '}
              <span className="font-mono">.agents/skills/&lt;name&gt;/</span> (project- or user-level
              depending on the tool)
            </li>
          </ul>
        </div>
      </details>
    </section>
  );
}

// ---------- 4. connected clients (audit) ----------
