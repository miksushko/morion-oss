import { z } from 'zod';

/**
 * Shared error mapping for the workflow write tools (workflows_create /
 * workflows_update / workflows_copy). The repository throws `z.ZodError`
 * on schema failures and `LinearWorkflowError` on linear-only
 * violations — both map to the same envelope shape the HTTP PUT route
 * emits (422 `invalid_workflow_definition` + issues[]), so an external
 * agent can read the issues, fix its JSON, and retry.
 */
export interface WorkflowValidationEnvelope {
  error: 'invalid_workflow_definition';
  message: string;
  issues: Array<{ path: string; message: string }>;
}

export function workflowValidationEnvelope(
  err: unknown,
): WorkflowValidationEnvelope {
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join('.') || 'definition',
      message: i.message,
    }));
    return {
      error: 'invalid_workflow_definition',
      message: `${issues[0].path}: ${issues[0].message}`,
      issues,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: 'invalid_workflow_definition',
    message,
    issues: [{ path: 'definition', message }],
  };
}
