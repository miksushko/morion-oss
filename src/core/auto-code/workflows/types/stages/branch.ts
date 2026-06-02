import { z } from 'zod';

export const BranchConditionSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'in', 'gt', 'lt', 'contains']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

export const BranchStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('branch'),
  combinator: z.enum(['all', 'any']).default('all'),
  conditions: z.array(BranchConditionSchema).min(1),
});
