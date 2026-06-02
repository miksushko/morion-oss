/**
 * Workflow-runner `~/.morion/runs/<sid>.jsonl` parser — translates the unified
 * `CliAgentEvent` stream (pi / codex / opencode / claude-via-harness) into the
 * shared `TranscriptMessage[]` the drawer consumes. Extracted from
 * `../transcript-reader.ts` (2026-05-16, ticket `01KRQYRTY348DAG9MM6JPMTDYR`).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type ParseTranscriptResult,
  type TranscriptMessage,
  summariseToolInput,
} from './types.js';

/**
 * Workflow runs write each `CliAgentEvent` as a JSONL line to
 * `~/.morion/runs/<sessionId>.jsonl`. Shape:
 *
 *   {kind:'session_start', sessionId, agent, timestamp}
 *   {kind:'tool_start', toolName, args, timestamp}
 *   {kind:'tool_end', toolName, result, durationMs, timestamp}
 *   {kind:'message', role:'assistant'|'user', content, timestamp}
 *   {kind:'text_delta', delta, timestamp}
 *   {kind:'result', exitCode, summary, costUsd, terminalReason, timestamp}
 *   {kind:'error', errorKind, message, recoverable, timestamp}
 *
 * Map these into the same `TranscriptMessage[]` shape the drawer
 * already consumes (assistant / user / tool_use / tool_result /
 * system) so one drawer surface covers both legacy claude
 * transcripts AND new workflow-runner JSONL.
 */
interface HarnessEventRow {
  kind?: string;
  timestamp?: number;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  role?: string;
  content?: string;
  delta?: string;
  exitCode?: number;
  summary?: string;
  costUsd?: number;
  terminalReason?: string;
  errorKind?: string;
  message?: string;
  recoverable?: boolean;
  agent?: string;
  sessionId?: string;
}

const HARNESS_SKIP_KINDS = new Set([
  // text_delta fires per-token; aggregated into the final `message`
  // anyway. Showing every delta would flood the drawer with single-
  // char rows.
  'text_delta',
  // session_start is a one-line announcement Claude / harness write
  // at the head — useful for debugging but noise in the user-facing
  // drawer.
  'session_start',
]);

export function parseHarnessTranscriptText(raw: string): ParseTranscriptResult {
  const messages: TranscriptMessage[] = [];
  const warnings: string[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let row: HarnessEventRow;
    try {
      row = JSON.parse(line) as HarnessEventRow;
    } catch (e) {
      warnings.push(`line ${i + 1}: JSON parse failed (${(e as Error).message})`);
      continue;
    }
    const kind = row.kind ?? '';
    if (!kind || HARNESS_SKIP_KINDS.has(kind)) continue;

    const id = `${i}`;
    const timestamp =
      typeof row.timestamp === 'number'
        ? new Date(row.timestamp).toISOString()
        : undefined;

    if (kind === 'message' && row.role === 'assistant') {
      messages.push({
        id,
        kind: 'assistant',
        text: row.content ?? '',
        timestamp,
      });
      continue;
    }
    if (kind === 'message' && row.role === 'user') {
      messages.push({
        id,
        kind: 'user',
        text: row.content ?? '',
        timestamp,
      });
      continue;
    }
    if (kind === 'tool_start') {
      messages.push({
        id,
        kind: 'tool_use',
        text: `${row.toolName ?? 'tool'}(${summariseToolInput(row.args)})`,
        toolUse: {
          name: row.toolName ?? 'tool',
          input: row.args,
          id,
        },
        timestamp,
      });
      continue;
    }
    if (kind === 'tool_end') {
      const isError = false; // harness puts errors on `error` kind, not tool_end
      const content = extractToolResultText(row.result);
      messages.push({
        id,
        kind: 'tool_result',
        text: content.slice(0, 400),
        toolResult: {
          toolUseId: id,
          content,
          isError,
        },
        timestamp,
      });
      continue;
    }
    if (kind === 'result') {
      // Terminal result — show as a system row so the user sees a
      // clean end-of-stream marker with cost + reason.
      const summary = (row.summary ?? '').trim();
      const cost =
        typeof row.costUsd === 'number'
          ? ` ($${row.costUsd.toFixed(4)})`
          : '';
      const reason = row.terminalReason ? ` [${row.terminalReason}]` : '';
      messages.push({
        id,
        kind: 'system',
        text: summary
          ? `Run finished${reason}${cost}\n\n${summary}`
          : `Run finished${reason}${cost}`,
        timestamp,
      });
      continue;
    }
    if (kind === 'error') {
      messages.push({
        id,
        kind: 'system',
        text: `Error [${row.errorKind ?? 'unknown'}]${row.recoverable ? ' (recoverable)' : ''}: ${row.message ?? ''}`,
        timestamp,
      });
      continue;
    }
  }
  return { messages, warnings };
}

/** Best-effort text extraction from a `tool_end` result envelope.
 *  Adapters serialise results differently (`{content: [{type:'text',text:''}]}`,
 *  raw string, structured `details.diff`). Pull the first text we
 *  recognise. */
function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  // claude / codex shape: { content: [{type:'text',text:'...'}] }
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === 'object') {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === 'string') return t;
      }
    }
  }
  // pi shape via `details.diff`
  if (r.details && typeof r.details === 'object') {
    const diff = (r.details as Record<string, unknown>).diff;
    if (typeof diff === 'string') return diff;
  }
  // Fallback — serialised JSON, capped so the drawer doesn't choke.
  try {
    return JSON.stringify(result).slice(0, 1000);
  } catch {
    return '';
  }
}

export async function parseHarnessTranscriptFile(
  path: string,
): Promise<ParseTranscriptResult> {
  if (!existsSync(path)) {
    return { messages: [], warnings: [`transcript file does not exist: ${path}`] };
  }
  const raw = await readFile(path, 'utf8');
  return parseHarnessTranscriptText(raw);
}
