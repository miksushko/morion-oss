/**
 * Single source of truth for Mo's billed LLM spend. Replaces the
 * previous `BudgetTracker` read over `concierge_messages.cost_usd`
 * which silently missed headless tick + brief digest costs and
 * double-counted chat tool-loop turns (`01KQ1H556RFFKD7WGZE77MEVFQ`).
 *
 * Append-only. Every `record()` writes exactly one row; `BudgetTracker`
 * sums `cost_usd` since the start of the current UTC month.
 *
 * Module layout (this file is a thin barrel under the 500-LOC cap):
 *   - `./mo-spend-ledger/types.ts` — MoSpendKind + MoSpendRow +
 *     RecordSpendInput + UsageAggregate shapes + DbRow
 *   - `./mo-spend-ledger/helpers.ts` — UTC month bounds, row mapping,
 *     LLMResponse → RecordSpendInput
 *   - `./mo-spend-ledger/aggregate-query.ts` — Usage-tab multi-GROUP-BY
 *   - `./mo-spend-ledger/repository.ts` — MoSpendLedgerRepository
 */

export {
  AUTO_CODE_KINDS,
  type AutoCodeSpendKind,
  type MoSpendAuthMode,
  type MoSpendKind,
  type MoSpendRow,
  type RecordSpendInput,
  type UsageAggregate,
  type UsageAggregateDaily,
  type UsageAggregatePerKind,
  type UsageAggregatePerModel,
  type UsageAggregatePerProvider,
} from './mo-spend-ledger/types.js';
export {
  spendInputFromLLMResponse,
  startOfNextUtcMonth,
  startOfUtcMonth,
} from './mo-spend-ledger/helpers.js';
export { MoSpendLedgerRepository } from './mo-spend-ledger/repository.js';
