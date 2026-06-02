import type { RefinementCtx, RefinementDef } from './types.js';
import { checkUniqueStageIds, checkEdgeEndpoints } from './stage-ids.js';
import { checkVerdictPolicyTargets } from './verdict-policy.js';
import {
  checkV2Cardinality,
  checkSinksHaveNoOutbound,
} from './v2-cardinality.js';
import {
  checkHumanGateSingleOut,
  checkDecisionEdgeAlignment,
} from './decision-edges.js';
import { checkTerminalReachability } from './reachability.js';

/** Run every workflow-definition refinement in document order.
 *  Order matters only for readability — each check independently
 *  pushes issues into `ctx`. */
export function runDefinitionRefinements(def: RefinementDef, ctx: RefinementCtx): void {
  checkUniqueStageIds(def, ctx);
  checkEdgeEndpoints(def, ctx);
  checkVerdictPolicyTargets(def, ctx);
  checkV2Cardinality(def, ctx);
  checkSinksHaveNoOutbound(def, ctx);
  checkHumanGateSingleOut(def, ctx);
  checkDecisionEdgeAlignment(def, ctx);
  checkTerminalReachability(def, ctx);
}

export type { RefinementCtx, RefinementDef };
