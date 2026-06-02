import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import { ImportEngine, ImportRegistry } from '../../core/import/index.js';
import type { ImportEvent, UploadedFile } from '../../core/import/index.js';
import {
  listAppleNotesFolders,
  AppleNotesPermissionError,
  AppleNotesNotInstalledError,
} from '../../core/import/index.js';

/**
 * Import from external sources — Phase 1 HTTP route.
 *
 * Three endpoints:
 *
 *   POST /api/import
 *     Body: {path, mode}
 *     Starts a new import batch. Returns 409 if another batch is
 *     already active (one global at a time invariant). Returns
 *     immediately with `{batchId}` — the actual work runs detached
 *     and progress is consumed via the SSE endpoint.
 *
 *   GET  /api/import/:batchId/stream
 *     SSE stream of `ImportEvent`s. Replays buffered events on
 *     subscribe so a late client (e.g. modal reopened on app
 *     restart) sees everything from `start` to `complete`. Then
 *     forwards live events while the batch runs. Closes the stream
 *     after `complete` / `cancelled`.
 *
 *   POST /api/import/:batchId/cancel
 *     Flips the engine's cancel flag. Already-imported notes stay;
 *     pending entries drop after current in-flight writes settle.
 *     Returns 200 with the (possibly partial) summary on next
 *     `complete` event.
 *
 * Concurrency invariant: the registry singleton enforces one active
 * batch at a time across all HTTP callers. Within a batch, the engine
 * parallelises file writes (default 5).
 *
 * Phase 2/3/4 add per-format inputs to POST /api/import (the body
 * gains a `format` field once docx / Apple Notes ship). Today only
 * markdown is wired.
 */

const startSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(['file', 'folder']),
});

export function registerImportRoutes(app: Hono, ctx: ToolContext): void {
  // Per-app registry. Production calls `buildHttpApp` ONCE at startup
  // → one registry for the sidecar's lifetime (the original contract).
  // Tests build a fresh app per test in setup() → fresh registry,
  // no leak from the previous test's still-draining import. Earlier
  // this lived at module scope which made the very first import in a
  // test leak its in-flight state into every subsequent test in the
  // same file (intermittent before commit `8fa7258`'s setImmediate
  // yield, deterministic after — yield delayed `registry.release`
  // past the next test's `setup()`).
  const registry = new ImportRegistry();

  app.post('/api/import', async (c) => {
    if (registry.isBusy()) {
      return c.json(
        {
          error: 'import_in_progress',
          message: 'Another import is already running. Wait for it to finish.',
          activeBatchId: registry.activeBatchId(),
        },
        409,
      );
    }

    // Two input shapes:
    //   1. JSON `{path, mode}` — legacy fs-based path import. Used by
    //      future Tauri native dialog that returns absolute paths.
    //   2. multipart/form-data — browser file upload. Each file part
    //      is named `file:<relPath>` so the relPath survives the
    //      transport without a separate manifest. `mode` is a
    //      regular form field.
    const contentType = c.req.header('Content-Type') ?? '';
    let pathInput: { path: string; mode: 'file' | 'folder' } | null = null;
    let uploadInput:
      | { mode: 'file'; file: UploadedFile }
      | { mode: 'folder'; files: UploadedFile[] }
      | null = null;
    let displayLabel = '<unknown>';

    if (contentType.includes('application/json')) {
      const raw = await c.req.json().catch(() => null);
      const parsed = startSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: 'invalid_request', issues: parsed.error.issues },
          400,
        );
      }
      pathInput = { path: parsed.data.path, mode: parsed.data.mode };
      displayLabel = parsed.data.path;
    } else if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody({ all: true });
      const mode = body.mode;
      if (mode !== 'file' && mode !== 'folder') {
        return c.json(
          { error: 'invalid_request', message: 'mode must be "file" or "folder"' },
          400,
        );
      }
      // Hono's parseBody returns File | string | (File|string)[] per key.
      // We use `file:<relPath>` as the key so each entry's relPath is
      // self-describing — no manifest needed.
      const uploadedFiles: UploadedFile[] = [];
      for (const [key, value] of Object.entries(body)) {
        if (!key.startsWith('file:')) continue;
        const relPath = key.slice('file:'.length);
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === 'string') continue;
          if (!item) continue;
          const arr = await item.arrayBuffer();
          // Phase 4: .docx is binary — base64-encode so the engine
          // can decide later (text or base64) based on extension.
          // Text formats stay UTF-8 strings (cheaper than base64).
          const isBinary = relPath.toLowerCase().endsWith('.docx');
          uploadedFiles.push({
            relPath,
            bytes: isBinary
              ? Buffer.from(arr).toString('base64')
              : Buffer.from(arr).toString('utf8'),
            encoding: isBinary ? 'base64' : 'text',
          });
        }
      }
      if (uploadedFiles.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            message:
              'multipart request had no file:* parts; expected at least one.',
          },
          400,
        );
      }
      uploadInput =
        mode === 'file'
          ? { mode: 'file', file: uploadedFiles[0]! }
          : { mode: 'folder', files: uploadedFiles };
      displayLabel = `<upload:${uploadedFiles.length} file(s)>`;
    } else {
      return c.json(
        {
          error: 'invalid_request',
          message:
            'Content-Type must be application/json (with {path, mode}) or multipart/form-data (with file:* parts).',
        },
        400,
      );
    }

    const engine = new ImportEngine(ctx.notes, ctx.folders, ctx.actor, {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    registry.reserve(engine);

    // Detach: run the engine without awaiting; clients consume
    // progress via the SSE endpoint. We ALWAYS release the registry
    // even on throw so a future POST can succeed.
    void (async () => {
      try {
        if (pathInput) {
          await engine.run({ absPath: pathInput.path, mode: pathInput.mode });
        } else if (uploadInput) {
          await engine.runFromUpload(uploadInput);
        }
      } catch (err) {
        // `run` already emits per-file errors as events. A throw here
        // is exceptional (e.g. unreadable root path / malformed
        // upload). Surface it as a synthetic event so the SSE consumer
        // sees it and the modal can close cleanly.
        engine.events.emit('event', {
          type: 'error',
          batchId: engine.id,
          error: { file: displayLabel, message: (err as Error).message },
        } satisfies ImportEvent);
        engine.events.emit('event', {
          type: 'complete',
          batchId: engine.id,
          summary: {
            batchId: engine.id,
            source: 'import:markdown',
            total: 0,
            imported: 0,
            errored: 1,
            cancelled: false,
            rootFolderId: null,
            errors: [
              { file: displayLabel, message: (err as Error).message },
            ],
          },
        } satisfies ImportEvent);
      } finally {
        registry.release(engine.id);
      }
    })();

    return c.json({ batchId: engine.id }, 202);
  });

  app.get('/api/import/:batchId/stream', (c) => {
    const batchId = c.req.param('batchId');
    return streamSSE(c, async (sse) => {
      // Replay any buffered events first so a late subscriber sees the
      // full history.
      for (const event of registry.bufferedEvents(batchId)) {
        await sse.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
        if (event.type === 'complete' || event.type === 'cancelled') {
          // Already finished — close stream after replay.
          return;
        }
      }
      // If batch is still active, attach a live listener.
      const engine = registry.findEngine(batchId);
      if (!engine) {
        await sse.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            batchId,
            error: { file: '', message: 'Unknown or expired batch.' },
          }),
        });
        return;
      }
      // Forward live events until complete / cancelled.
      await new Promise<void>((resolve) => {
        const handler = (event: ImportEvent): void => {
          void sse.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          if (event.type === 'complete' || event.type === 'cancelled') {
            engine.events.off('event', handler);
            resolve();
          }
        };
        engine.events.on('event', handler);
      });
    });
  });

  app.post('/api/import/:batchId/cancel', (c) => {
    const batchId = c.req.param('batchId');
    const engine = registry.findEngine(batchId);
    if (!engine) {
      return c.json(
        { error: 'unknown_batch', message: 'No active import with that id.' },
        404,
      );
    }
    engine.cancel();
    return c.json({ ok: true, batchId });
  });

  app.get('/api/import/active', (c) => {
    return c.json({
      active: registry.activeBatchId(),
      busy: registry.isBusy(),
    });
  });

  // ---------- Apple Notes (Phase 3) ----------

  app.get('/api/import/apple-notes/folders', async (c) => {
    if (process.platform !== 'darwin') {
      return c.json(
        {
          error: 'platform_unsupported',
          message: 'Apple Notes import is macOS-only.',
        },
        400,
      );
    }
    try {
      const folders = await listAppleNotesFolders();
      return c.json({ folders });
    } catch (err) {
      if (err instanceof AppleNotesPermissionError) {
        return c.json(
          { error: 'apple_notes_permission_denied', message: err.message },
          403,
        );
      }
      if (err instanceof AppleNotesNotInstalledError) {
        return c.json(
          { error: 'apple_notes_not_installed', message: err.message },
          400,
        );
      }
      return c.json(
        { error: 'apple_notes_probe_failed', message: (err as Error).message },
        500,
      );
    }
  });

  const appleNotesImportSchema = z.object({
    folders: z
      .array(
        z.object({
          accountName: z.string().min(1),
          folderPath: z.string().min(1),
        }),
      )
      .min(1),
  });

  app.post('/api/import/apple-notes', async (c) => {
    if (process.platform !== 'darwin') {
      return c.json(
        {
          error: 'platform_unsupported',
          message: 'Apple Notes import is macOS-only.',
        },
        400,
      );
    }
    if (registry.isBusy()) {
      return c.json(
        {
          error: 'import_in_progress',
          message: 'Another import is already running. Wait for it to finish.',
          activeBatchId: registry.activeBatchId(),
        },
        409,
      );
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = appleNotesImportSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', issues: parsed.error.issues },
        400,
      );
    }
    const engine = new ImportEngine(ctx.notes, ctx.folders, ctx.actor, {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    registry.reserve(engine);
    void (async () => {
      try {
        await engine.runFromAppleNotes({ selectedFolders: parsed.data.folders });
      } catch (err) {
        engine.events.emit('event', {
          type: 'error',
          batchId: engine.id,
          error: { file: '<apple-notes>', message: (err as Error).message },
        } satisfies ImportEvent);
        engine.events.emit('event', {
          type: 'complete',
          batchId: engine.id,
          summary: {
            batchId: engine.id,
            source: 'import:apple-notes',
            total: 0,
            imported: 0,
            errored: 1,
            cancelled: false,
            rootFolderId: null,
            errors: [{ file: '<apple-notes>', message: (err as Error).message }],
          },
        } satisfies ImportEvent);
      } finally {
        registry.release(engine.id);
      }
    })();
    return c.json({ batchId: engine.id }, 202);
  });
}
