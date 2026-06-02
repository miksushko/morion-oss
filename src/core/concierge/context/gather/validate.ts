import type { GatherInput } from '../types.js';

/** Throw when the caller violates the `gatherContext` contract:
 *  exactly one of `taskId` (entity-focused gather) OR `question`
 *  (free-form gather) must be supplied. Mixing them OR omitting
 *  both is an upstream bug — fail loud so the caller sees it during
 *  development rather than getting silent wrong-shape packets. */
export function validateInput(input: GatherInput): void {
  const hasTask = !!input.taskId;
  const hasQuestion = !!input.question;
  if (hasTask === hasQuestion) {
    throw new Error(
      'gatherContext: exactly one of `taskId` or `question` must be supplied',
    );
  }
}
