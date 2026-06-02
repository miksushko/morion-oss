import { ConciergePanel } from '../layout/ConciergePanel';
import { cn } from '../lib/cn';
import type { MobilePane } from '../appShellTypes';

/**
 * Concierge view branch — `<ConciergePanel />` inside the editor pane
 * slot. Owns the wiring to `useConciergeChat` (preselect / autoOpen /
 * inflight set) + needs-human-badge refresh on any panel interaction.
 */
export interface ConciergeViewProps {
  paneClass: (pane: MobilePane) => string;
  setMobilePane: (pane: MobilePane) => void;
  preselectSessionId: string | null;
  setPreselectSessionId: (id: string | null) => void;
  autoOpenSettings: boolean;
  setAutoOpenSettings: (next: boolean) => void;
  inflightSessionIds: Set<string>;
  onSendMessage: (sessionId: string, content: string) => Promise<unknown>;
  onStopSending: (sessionId: string) => void;
  refreshNeedsHumanCount: () => void;
  onOpenMoAgentSettings: () => void;
}

export function ConciergeView(props: ConciergeViewProps) {
  const {
    paneClass,
    setMobilePane,
    preselectSessionId,
    setPreselectSessionId,
    autoOpenSettings,
    setAutoOpenSettings,
    inflightSessionIds,
    onSendMessage,
    onStopSending,
    refreshNeedsHumanCount,
    onOpenMoAgentSettings,
  } = props;

  return (
    <div className={cn('min-w-0 flex-1', paneClass('editor'))}>
      <ConciergePanel
        onMobileBack={() => setMobilePane('folders')}
        preselectSessionId={preselectSessionId}
        onPreselectConsumed={() => setPreselectSessionId(null)}
        autoOpenSettings={autoOpenSettings}
        onAutoOpenConsumed={() => setAutoOpenSettings(false)}
        onOpenMoAgentSettings={onOpenMoAgentSettings}
        inflightSessionIds={inflightSessionIds}
        onSendMessage={async (sessionId, content) => {
          await onSendMessage(sessionId, content);
        }}
        onStopSending={onStopSending}
        onSessionOpened={() => {
          // Any interaction inside the panel (select, send, archive)
          // can shift needsHuman counts — refresh sidebar badge.
          refreshNeedsHumanCount();
        }}
      />
    </div>
  );
}
