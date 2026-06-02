/** Phase 5 follow-up — describes a session the user can open inside
 *  the drawer transcript. Comes from `GET /api/auto-code/queue/:id/
 *  sessions`. Workflow-shaped runs return one per stage row with a
 *  session id; legacy mo_agent_queue rows return up to two
 *  ("fix"/"review"). */
export interface DrawerSessionEntry {
  rowId?: string; // workflow stage row id; absent on legacy
  stageId: string;
  stageKind: string;
  agentName: string | null;
  sessionId: string;
  status: string;
  attempt: number;
  label: string;
  engine: 'legacy' | 'workflow';
}

export interface MergeOutcome {
  kind: 'idle' | 'merging' | 'ok' | 'err';
  /** Success message OR error message — set when kind is `ok` / `err`. */
  message?: string;
  /** Backend error code when kind=`err`. Drives conditional UI like
   *  "Resolve conflict" button (shown only for `merge_conflict`). */
  errorCode?: string;
  /** Short diff stat from server (success path only). */
  stat?: string | null;
}
