import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  activatePro,
  setup,
  type Ctx,
} from './helpers/concierge-http-setup.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';

/**
 * GET /api/auto-code/workflows must return a STRUCTURED 500 envelope
 * (with `error / step / message / folderId`) when an internal helper
 * throws — never a Hono empty-body crash.
 *
 * Regression for ticket 01KRR7VEGNNNE80R4EPABDHATD (2026-05-16): the
 * user reported "GET /api/auto-code/workflows?folderId=... failed:
 * 500" while the popup was loading; the network tab showed a bare 500
 * with no body, leaving them with no actionable error to file. The
 * pipeline (purgeLegacyAndHeal → seedDefaultsForFolder → align →
 * listSummariesForFolder) had no error handling at all, so any throw
 * from any helper bubbled to Hono's default error responder.
 *
 * The fix wraps the entire pipeline in a try/catch + console.error,
 * tagging the failing step. This test pins that contract.
 */
describe('GET /api/auto-code/workflows — error envelope', () => {
  let ctx: Ctx;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
    // Suppress the [auto-code/workflows GET] failed log so test
    // output stays clean. Stack still captured by the spy for
    // assertion below.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('wraps a thrown listSummariesForFolder into a structured 500 envelope', async () => {
    const folder = ctx.folders.create('F');
    // Inject a throwing helper at the LAST step of the pipeline.
    // Guarantees purge + seed + align all completed; the 500
    // envelope's `step` field must read 'list_summaries'.
    const spy = vi
      .spyOn(WorkflowsRepository.prototype, 'listSummariesForFolder')
      .mockImplementation(() => {
        throw new Error('synthetic listSummariesForFolder failure');
      });

    const res = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      step: string;
      message: string;
      folderId: string;
    };
    expect(body.error).toBe('auto_code_workflows_failed');
    expect(body.step).toBe('list_summaries');
    expect(body.message).toContain('synthetic listSummariesForFolder failure');
    expect(body.folderId).toBe(folder.id);

    // console.error was called with the failing step + message so
    // the next user can paste it into a ticket without grepping
    // logs.
    expect(consoleErrorSpy).toHaveBeenCalled();
    const call = consoleErrorSpy.mock.calls[0]!;
    expect(call[0]).toBe('[auto-code/workflows GET] failed');
    const meta = call[1] as { folderId: string; step: string; error: string };
    expect(meta.folderId).toBe(folder.id);
    expect(meta.step).toBe('list_summaries');
    expect(meta.error).toContain('synthetic listSummariesForFolder failure');

    spy.mockRestore();
  });

  it('healthy path still returns 200 with the workflows array', async () => {
    const folder = ctx.folders.create('F');
    const res = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    expect(Array.isArray(body.workflows)).toBe(true);
    // Seeding inserts the registry templates; non-empty list.
    expect(body.workflows.length).toBeGreaterThan(0);
  });
});
