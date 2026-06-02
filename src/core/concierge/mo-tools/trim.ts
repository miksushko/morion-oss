/**
 * Shape-aware oversize-envelope trimmer. Each branch keeps the
 * load-bearing fields the next chat turn needs to maintain
 * continuity, drops telemetry/long-string fields agents rarely
 * re-read, and tail-trims the dominant string with an explicit
 * suffix so the LLM can detect the truncation.
 *
 * Used only when `serializeMoToolResultForChat` measures the raw
 * envelope JSON over the byte budget — never produces a sliced /
 * mid-JSON string.
 */

export const TRUNCATED_BODY_TAIL =
  '\n\n…[truncated for chat budget — call notes_get over MCP for full body]';

export function trimEnvelopeToFit(
  toolName: string,
  env: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (env.ok !== true || !('data' in env)) {
    return {
      error: 'payload_too_large',
      tool: toolName,
      hint: 'response oversized for chat; narrow query or paginate',
    };
  }
  const data = (env as { data: unknown }).data;

  // Top-level array shape — notes_list, notes_recent, etc.
  if (Array.isArray(data)) {
    const total = data.length;
    // Build the FINAL hint upfront so trial-JSON measurements match the
    // returned envelope byte-for-byte (a shorter placeholder hint would
    // let trial fit but the real return overflow).
    const buildEnvelope = (kept: unknown[]) => ({
      ok: true,
      data: {
        truncated: true,
        returned: kept.length,
        total,
        items: kept,
        hint: `${toolName} returned ${total} rows; ${kept.length} fit in chat budget. Narrow with filters, paginate, or read individual ids.`,
      },
    });
    const items = fitItems(
      data,
      (kept) => JSON.stringify(buildEnvelope(kept)),
      maxBytes,
    );
    return buildEnvelope(items);
  }

  // tasks_list shape: { folder, tasks }
  if (
    toolName === 'tasks_list' &&
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { tasks?: unknown }).tasks)
  ) {
    const obj = data as Record<string, unknown>;
    const folder = obj.folder;
    const tasks = obj.tasks as unknown[];
    const total = tasks.length;
    const buildEnvelope = (kept: unknown[]) => ({
      ok: true,
      data: {
        folder,
        truncated: true,
        returned: kept.length,
        total,
        tasks: kept,
        hint: `tasks_list returned ${total} cards; ${kept.length} fit in chat budget. Filter by status or use a tighter time window.`,
      },
    });
    const items = fitItems(
      tasks,
      (kept) => JSON.stringify(buildEnvelope(kept)),
      maxBytes,
    );
    return buildEnvelope(items);
  }

  // mo_get_context: WorkContextPacket-shaped envelope. The synthesised
  // markdown can run 8-15kB on its own, plus bootstrap state +
  // citedNoteIds + risks + warnings. Without a dedicated trim path
  // it falls through to the "Unknown oversize shape" stub at the
  // bottom — which means the next chat turn loses the entire
  // synthesis (Gemini takes over and sees just `{error:
  // 'payload_too_large', ...}` instead of the actual answer
  // deepseek/qwen produced). Real-world incident 2026-05-04: Mo
  // produced a great Morion Features overview, the user asked a
  // follow-up, and Gemini-the-chat-tier got the stub → "deepseek
  // ответил, а Gemini лишился контекста".
  //
  // Fix: keep packetMarkdown + citedNoteIds + risks + cacheHit +
  // capped (the load-bearing fields the next turn needs to maintain
  // continuity). Drop bootstrap (telemetry-heavy) + warnings (long
  // strings agents rarely need to re-read). Tail-trim packetMarkdown
  // with explicit suffix if still oversize.
  //
  // mo_ask shape is similar enough — same { ok, data: {answer,
  // sources, ...} } envelope, but `answer` lives at data.answer
  // not data.packetMarkdown. Handle both.
  const isGatherShape =
    toolName === 'mo_get_context' &&
    data &&
    typeof data === 'object' &&
    'packetMarkdown' in (data as object);
  const isAskShape =
    toolName === 'mo_ask' &&
    data &&
    typeof data === 'object' &&
    'answer' in (data as object);
  if (isGatherShape || isAskShape) {
    const pkt = data as Record<string, unknown>;
    const markdownKey = isGatherShape ? 'packetMarkdown' : 'answer';
    const fullMarkdown = typeof pkt[markdownKey] === 'string' ? (pkt[markdownKey] as string) : '';
    // Slim the envelope: keep markdown + cited refs + risks + cache
    // provenance + cap state. Drop bootstrap (telemetry), warnings
    // (long), keywords/clusterRoutes (already implicit in markdown
    // citations).
    const buildEnvelope = (cappedMarkdown: string) => ({
      ok: true,
      data: {
        ...(isGatherShape
          ? { packetMarkdown: cappedMarkdown }
          : { answer: cappedMarkdown }),
        citedNoteIds: pkt.citedNoteIds ?? [],
        risks: pkt.risks ?? [],
        cacheHit: pkt.cacheHit ?? null,
        capped: pkt.capped ?? null,
        truncated: cappedMarkdown.length < fullMarkdown.length,
        markdownTotalLength: fullMarkdown.length,
      },
    });
    const overheadJson = JSON.stringify(buildEnvelope(''));
    let room = Math.max(0, maxBytes - overheadJson.length - TRUNCATED_BODY_TAIL.length - 32);
    let cappedMarkdown =
      fullMarkdown.length > room ? fullMarkdown.slice(0, room) + TRUNCATED_BODY_TAIL : fullMarkdown;
    let envelope = buildEnvelope(cappedMarkdown);
    let envelopeJson = JSON.stringify(envelope);
    for (let pass = 0; pass < 8 && envelopeJson.length > maxBytes && room > 0; pass++) {
      room = Math.max(0, Math.floor(room * 0.9) - 64);
      cappedMarkdown = fullMarkdown.slice(0, room) + TRUNCATED_BODY_TAIL;
      envelope = buildEnvelope(cappedMarkdown);
      envelopeJson = JSON.stringify(envelope);
    }
    return envelope;
  }

  // notes_get: single Note with full body. Cap body to fit. Iterative
  // because JSON escape inflation (e.g. \n→\\n, non-ASCII) makes a
  // single-shot calculation unreliable — measure, shrink, re-measure.
  if (
    toolName === 'notes_get' &&
    data &&
    typeof data === 'object' &&
    'body' in (data as object)
  ) {
    const note = data as Record<string, unknown>;
    const body = typeof note.body === 'string' ? note.body : '';
    const buildEnvelope = (cappedBody: string) => ({
      ok: true,
      data: {
        ...note,
        body: cappedBody,
        truncated: cappedBody.length < body.length,
        bodyTotalLength: body.length,
      },
    });
    // Start with a generous estimate, then shrink until it fits.
    const overheadJson = JSON.stringify(buildEnvelope(''));
    let room = Math.max(0, maxBytes - overheadJson.length - TRUNCATED_BODY_TAIL.length - 32);
    let cappedBody =
      body.length > room ? body.slice(0, room) + TRUNCATED_BODY_TAIL : body;
    let envelope = buildEnvelope(cappedBody);
    let envelopeJson = JSON.stringify(envelope);
    // Shrink loop. JSON-escape inflation rarely needs more than 1-2
    // passes; cap at 8 to defend against pathological inputs.
    for (let pass = 0; pass < 8 && envelopeJson.length > maxBytes && room > 0; pass++) {
      room = Math.max(0, Math.floor(room * 0.9) - 64);
      cappedBody = body.slice(0, room) + TRUNCATED_BODY_TAIL;
      envelope = buildEnvelope(cappedBody);
      envelopeJson = JSON.stringify(envelope);
    }
    return envelope;
  }

  // Unknown oversize shape — generic stub.
  return {
    error: 'payload_too_large',
    tool: toolName,
    hint: 'response oversized for chat; narrow query or paginate',
  };
}

export function fitItems(
  items: unknown[],
  buildJson: (kept: unknown[]) => string,
  maxBytes: number,
): unknown[] {
  const kept: unknown[] = [];
  for (const item of items) {
    const trial = buildJson([...kept, item]);
    if (trial.length > maxBytes) break;
    kept.push(item);
  }
  return kept;
}
