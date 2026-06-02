import { KeyRound } from 'lucide-react';
import { SwitchRow } from '../SwitchRow';

/**
 * Shared chrome for FolderSettingsDialog tabs.
 *
 *  - <NoKeyBanner>     — surfaced on AI Access when no provider key is
 *                        configured workspace-wide.
 *  - <BlockedBanner>   — surfaced on Mo-dependent tabs when the folder
 *                        is hidden from AI.
 *  - <MoEnableBanner>  — surfaced on Mo-dependent tabs when the folder
 *                        is visible to AI but Mo indexing is off. Has
 *                        an inline toggle so the user can flip indexing
 *                        on without leaving the current tab.
 */

export function NoKeyBanner({
  onOpen,
  onRefresh,
}: {
  onOpen?: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Mo needs a model first</div>
          <div className="mt-0.5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
            Mo's built-in model isn't available yet in this release. Open Ask
            Mo → gear icon to paste an OpenRouter or Groq key once for the
            whole workspace. Enabling Mo on this folder unlocks after.
          </div>
          <div className="mt-2 flex items-center gap-3">
            {onOpen && (
              <button
                type="button"
                onClick={onOpen}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-500/30 dark:text-amber-300"
              >
                Open Mo settings
              </button>
            )}
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="text-[10px] text-amber-700 hover:underline dark:text-amber-400"
            >
              I just saved a key — refresh
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BlockedBanner({
  reason,
  hint,
}: {
  reason: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400">
      <div className="font-medium">{reason}</div>
      <div className="mt-0.5 text-amber-700/90 dark:text-amber-400/90">{hint}</div>
    </div>
  );
}

/**
 * "Mo is not enabled on this folder" banner with an inline toggle so
 * the user can enable indexing without hopping back to Access Permissions.
 * Used on both the Workflow and Memory tabs. The toggle is the same
 * SwitchRow primitive as the canonical row on AI Access — same
 * affordance, same state, just shown inline alongside the explanation.
 */
export function MoEnableBanner({
  moEnabled,
  canEnableMo,
  savingMo,
  onToggleMo,
}: {
  moEnabled: boolean;
  canEnableMo: boolean;
  savingMo: boolean;
  onToggleMo: (next: boolean) => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
        AI Data Indexing is off for this folder
      </div>
      <div className="mt-0.5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
        These tabs stay inactive until indexing is on. Flip the switch
        below — no need to leave this tab.
      </div>
      <div className="mt-2 rounded-md bg-background/40 px-2 py-1">
        <SwitchRow
          label="AI Data Indexing"
          hint={
            canEnableMo
              ? 'Mo runs background indexing here so Ask Mo can answer questions about this folder with cited sources.'
              : 'Disabled until you turn on "MCP & Mo Access" or configure a model in Mo workspace settings.'
          }
          checked={moEnabled}
          onChange={(v) => void onToggleMo(v)}
          disabled={!canEnableMo && !moEnabled}
        />
      </div>
      {savingMo && (
        <div className="mt-1 text-[10px] text-amber-700/80 dark:text-amber-400/80">
          Saving…
        </div>
      )}
    </div>
  );
}
