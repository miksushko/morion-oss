/**
 * Claude `~/.claude/projects/<encoded>/<sid>.jsonl` parser — translates the
 * native Claude transcript shape into the unified `TranscriptMessage[]` the
 * AutoCodeDrawer renders. Extracted from `../transcript-reader.ts`
 * (2026-05-16, ticket `01KRQYRTY348DAG9MM6JPMTDYR`).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type ParseTranscriptResult,
  type TranscriptMessage,
  summariseToolInput,
} from './types.js';

interface RawJsonlRow {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          id?: string;
          tool_use_id?: string;
          content?: string | Array<{ type?: string; text?: string }>;
          is_error?: boolean;
        }>;
  };
}

/**
 * Skip these row types — they're metadata Claude writes alongside
 * the actual conversation but don't belong in the user-facing
 * drawer. `queue-operation` rows mark prompt enqueue/dequeue;
 * `ai-title` is Claude generating a session title; `attachment`
 * carries file-uploads metadata; `last-prompt` is internal.
 */
const SKIP_ROW_TYPES = new Set(['queue-operation', 'ai-title', 'attachment', 'last-prompt']);

/**
 * Parse a JSONL transcript into the UI-friendly message array.
 * Tolerates malformed rows (logs the JSON-parse error to a
 * warnings array but keeps reading) — Claude occasionally writes
 * partial lines mid-flush, and we don't want one bad row to
 * blank the whole drawer.
 */
export function parseTranscriptText(raw: string): ParseTranscriptResult {
  const messages: TranscriptMessage[] = [];
  const warnings: string[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let row: RawJsonlRow;
    try {
      row = JSON.parse(line) as RawJsonlRow;
    } catch (err) {
      warnings.push(`line ${i + 1}: ${(err as Error).message}`);
      continue;
    }
    const type = row.type;
    if (!type || SKIP_ROW_TYPES.has(type)) continue;
    if (type !== 'user' && type !== 'assistant' && type !== 'system') continue;

    const role = row.message?.role ?? type;
    const content = row.message?.content;
    const baseId = row.uuid ?? `line-${i + 1}`;

    if (typeof content === 'string') {
      // Plain string content — just text. User prompts arrive in
      // this shape; assistants only emit string content for the
      // very first turn before they discover their content-block
      // capability.
      messages.push({
        id: baseId,
        kind: role === 'assistant' ? 'assistant' : 'user',
        text: content,
        timestamp: row.timestamp,
      });
      continue;
    }

    if (!Array.isArray(content)) continue;

    // Walk content blocks. Each block becomes its own UI row so
    // a single assistant turn with text + 3 tool calls renders as
    // 4 visually-distinct bubbles.
    let blockIdx = 0;
    for (const block of content) {
      const blockId = `${baseId}#${blockIdx++}`;
      const blockType = block.type;
      if (blockType === 'text') {
        if (!block.text || block.text.trim().length === 0) continue;
        messages.push({
          id: blockId,
          kind: role === 'assistant' ? 'assistant' : 'user',
          text: block.text,
          timestamp: row.timestamp,
        });
      } else if (blockType === 'tool_use') {
        messages.push({
          id: blockId,
          kind: 'tool_use',
          text: `${block.name ?? '?'}(${summariseToolInput(block.input)})`,
          toolUse: {
            name: typeof block.name === 'string' ? block.name : '?',
            input: block.input,
            id: typeof block.id === 'string' ? block.id : blockId,
          },
          timestamp: row.timestamp,
        });
      } else if (blockType === 'tool_result') {
        const text = stringifyToolResult(block.content);
        messages.push({
          id: blockId,
          kind: 'tool_result',
          text,
          toolResult: {
            toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            content: text,
            isError: block.is_error === true,
          },
          timestamp: row.timestamp,
        });
      }
      // Unknown block types (extended thinking, server-tool, etc.)
      // are silently dropped — we'd rather ship a UI that's missing
      // a future block type than crash on first contact with one.
    }
  }
  return { messages, warnings };
}

export async function parseTranscriptFile(path: string): Promise<ParseTranscriptResult> {
  if (!existsSync(path)) return { messages: [], warnings: [`transcript file does not exist: ${path}`] };
  const raw = await readFile(path, 'utf8');
  return parseTranscriptText(raw);
}

function stringifyToolResult(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Tool results from Anthropic API arrive as content blocks;
  // join the text blocks so the UI gets a clean string.
  return content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}
