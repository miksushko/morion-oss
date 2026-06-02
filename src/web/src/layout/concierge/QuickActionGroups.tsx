import { useState } from 'react';
import type { ConciergeQuickAction } from '../../lib/api';

/**
 * Quick-action groups rendered under an assistant message. Action ids
 * follow `<group-prefix>:<idx>:<verb>` convention emitted by the
 * producer (e.g. `bundle:0:use-foo`, `bundle:0:keep-all`,
 * `demote:0:apply`, `demote:0:keep`). We group actions by their first
 * two segments (`bundle:0` / `demote:0`) and render a Claude-style
 * vertical option list per group — no outer border (the chat bubble
 * already provides framing), each option is a soft-filled pill.
 *
 * Click on any option in a group = single apply. The third option
 * "Give different instruction" expands an inline textarea + Send so
 * the user can type a custom decision; on submit, a phantom replied
 * action id `<group-key>:custom` lands in the transcript and the
 * group collapses to a decided state.
 *
 * Once any sibling action OR the custom instruction has been replied
 * to, the whole group collapses showing which option was picked
 * (matched by id) or just "Custom instruction sent" (custom path).
 */
export function QuickActionGroups({
  messageId,
  actions,
  repliedActionIds,
  onClick,
  onCustomReply,
  disabled,
}: {
  messageId: string;
  actions: ConciergeQuickAction[];
  repliedActionIds: Set<string>;
  onClick: (actionId: string) => void;
  onCustomReply: (groupKey: string, text: string) => void;
  disabled?: boolean;
}) {
  // Group by prefix `<kind>:<idx>` (first two colon-separated segments).
  const groupKey = (id: string): string => {
    const parts = id.split(':');
    if (parts.length < 2) return id;
    return `${parts[0]}:${parts[1]}`;
  };
  const groupOrder: string[] = [];
  const grouped = new Map<string, ConciergeQuickAction[]>();
  for (const a of actions) {
    const key = groupKey(a.id);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      groupOrder.push(key);
    }
    grouped.get(key)!.push(a);
  }

  // Track which groups are in "custom-instruction" expanded mode +
  // their draft text. Local state — closes on submit/cancel/refresh.
  const [customOpen, setCustomOpen] = useState<Set<string>>(new Set());
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({});
  const [customSubmitting, setCustomSubmitting] = useState<Set<string>>(new Set());

  const toggleCustom = (key: string) => {
    setCustomOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const setDraft = (key: string, value: string) => {
    setCustomDrafts((prev) => ({ ...prev, [key]: value }));
  };
  const submitCustom = async (key: string) => {
    const text = (customDrafts[key] ?? '').trim();
    if (!text) return;
    setCustomSubmitting((prev) => new Set(prev).add(key));
    try {
      await onCustomReply(key, text);
      setCustomOpen((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setCustomDrafts((prev) => {
        const { [key]: _, ...rest } = prev;
        return rest;
      });
    } finally {
      setCustomSubmitting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3" data-message-id={messageId}>
      {groupOrder.map((key) => {
        const groupActions = grouped.get(key)!;
        const pickedAction = groupActions.find((a) =>
          repliedActionIds.has(a.id),
        );
        const customReplied = repliedActionIds.has(`${key}:custom`);
        const groupDecided = pickedAction != null || customReplied;
        const isCustomOpen = customOpen.has(key);
        const isCustomBusy = customSubmitting.has(key);

        return (
          <div key={key} className="flex flex-col gap-1.5">
            {groupActions.map((a) => {
              const isPicked = pickedAction?.id === a.id;
              const isPickedSibling = groupDecided && !isPicked;
              const isPrimary = a.kind === 'primary';
              const stateClass = isPicked
                ? 'bg-primary text-primary-foreground border-primary'
                : isPickedSibling
                ? 'bg-muted/30 text-muted-foreground border-transparent'
                : isPrimary
                ? 'bg-muted/40 text-foreground border-primary/40 hover:bg-primary/15 hover:border-primary'
                : 'bg-muted/40 text-foreground border-transparent hover:bg-muted/70';
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled || groupDecided}
                  onClick={() => onClick(a.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-[12.5px] leading-snug transition-colors disabled:cursor-not-allowed ${stateClass}`}
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${isPicked ? 'border-primary-foreground bg-primary-foreground' : 'border-current opacity-60'}`}
                  >
                    {isPicked && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                  </span>
                  <span className="flex-1">{a.label}</span>
                  {isPicked && (
                    <span className="text-[10px] uppercase tracking-wide opacity-80">picked</span>
                  )}
                </button>
              );
            })}

            {/* "Give different instruction" — expands an inline
               textarea so the user can type a custom decision in
               place. Submit calls onCustomReply which posts the
               text + tags it with the phantom `<key>:custom`
               replied id so the group collapses on refresh. */}
            {!groupDecided && !isCustomOpen && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggleCustom(key)}
                className="flex w-full items-center gap-2.5 rounded-md border border-transparent bg-muted/40 px-3 py-2.5 text-left text-[12.5px] leading-snug text-foreground transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current opacity-60" />
                <span className="flex-1">Give different instruction…</span>
              </button>
            )}
            {customReplied && (
              <div className="flex w-full items-center gap-2.5 rounded-md border border-transparent bg-muted/30 px-3 py-2.5 text-[12.5px] leading-snug text-muted-foreground">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 border-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
                <span className="flex-1">Custom instruction sent</span>
              </div>
            )}
            {isCustomOpen && (
              <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2.5">
                <textarea
                  value={customDrafts[key] ?? ''}
                  onChange={(e) => setDraft(key, e.target.value)}
                  placeholder="Describe what to do with these topics — Mo will read it and act in this thread."
                  rows={3}
                  disabled={isCustomBusy}
                  autoFocus
                  className="resize-y rounded-md border border-border bg-background px-2.5 py-2 text-[12.5px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={isCustomBusy}
                    onClick={() => toggleCustom(key)}
                    className="rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isCustomBusy || !(customDrafts[key]?.trim())}
                    onClick={() => void submitCustom(key)}
                    className="rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {isCustomBusy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
