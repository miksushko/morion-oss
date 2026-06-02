import type { Hono } from 'hono';
import { ZodError } from 'zod';

/**
 * Global error handler. Zod validation failures become structured 400s
 * so the UI (and any MCP-adjacent tooling) gets a useful response
 * instead of a bare 500. Everything else falls through to hono's
 * default 500 — we still see real bugs in logs. Lives in its own file
 * so route modules don't have to care about ZodError imports.
 */
export function registerErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: 'validation',
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        400,
      );
    }
    console.error('unhandled http error', err);
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });
}
