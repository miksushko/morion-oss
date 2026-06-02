/**
 * Tauri IPC wrappers for the bundled morion skill (`skills/morion/`).
 *
 * In dev / browser mode (no Tauri shell) every call resolves to a "no
 * bundle / not installed" envelope so the Settings UI renders an
 * informative placeholder instead of throwing. The bundle path is only
 * present in the desktop production build — that's the documented
 * invariant.
 */
import { isTauri } from './env';

export interface SkillState {
  name: string;
  installed: boolean;
  /** True when the install path exists but lacks our `.morion-version`
   *  marker — a different process / user / earlier rev installed at
   *  this path. UI must warn before overwriting. */
  installedExternally: boolean;
  /** SemVer from bundled SKILL.md (production build) or null in dev. */
  bundledVersion: string | null;
  /** SemVer from the user's installed SKILL.md, possibly user-edited. */
  installedVersion: string | null;
  /** SemVer recorded in `.morion-version` at the user's last install. */
  markerVersion: string | null;
  bundledHash: string | null;
  installedHash: string | null;
  markerHash: string | null;
  /** True when installedHash != markerHash — user edited locally. */
  customised: boolean;
  /** True when bundledHash != markerHash AND skill is installed. */
  updateAvailable: boolean;
  installPath: string;
  bundledPath: string | null;
}

const NOT_TAURI: SkillState = {
  name: 'morion',
  installed: false,
  installedExternally: false,
  bundledVersion: null,
  installedVersion: null,
  markerVersion: null,
  bundledHash: null,
  installedHash: null,
  markerHash: null,
  customised: false,
  updateAvailable: false,
  installPath: '',
  bundledPath: null,
};

async function invokeIpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error(`skill IPC '${cmd}' is desktop-only (Tauri shell required)`);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export const skillsApi = {
  /**
   * Pure read: describes bundled + installed state. Safe to call any
   * time (settings panel mount, post-install refresh, polling). No
   * side effects on disk.
   *
   * In browser/dev mode returns a non-installed placeholder so the
   * UI doesn't crash on `await`.
   */
  async getState(): Promise<SkillState> {
    if (!isTauri) return { ...NOT_TAURI };
    return invokeIpc<SkillState>('skill_get_state');
  },

  /**
   * Copy the bundled skill into `~/.claude/skills/morion/`. Pass
   * `force: true` to override the customised-install / external-install
   * guards (the UI flips this to true after showing a confirm dialog).
   */
  async install(force = false): Promise<SkillState> {
    return invokeIpc<SkillState>('skill_install', { force });
  },

  /**
   * Remove `~/.claude/skills/morion/`. Refuses if the directory lacks
   * our `.morion-version` marker — the UI surfaces that as "Installed
   * by another tool — manage it yourself".
   */
  async uninstall(): Promise<SkillState> {
    return invokeIpc<SkillState>('skill_uninstall');
  },
};
