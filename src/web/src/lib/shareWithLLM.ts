/**
 * Clipboard payload formatters for the "Share with LLM" buttons.
 *
 * Minimal — just the id + title. The LLM knows the morion MCP tools
 * from their descriptions and will call notes_get / notes_list itself.
 */

import type { Note, Folder } from './api';

/** One-line note reference: title + id. */
export function formatNoteShare(note: Note): string {
  return `Morion note "${note.title}" (${note.id})`;
}

/** One-line folder reference: name + id + count. */
export function formatFolderShare(folder: Folder, noteCount: number): string {
  return `Morion folder "${folder.name}" (${folder.id}), ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`;
}

/**
 * Copy text to the clipboard. Throws if the Clipboard API isn't available
 * (rare in modern browsers but possible over plain HTTP outside loopback).
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('Clipboard API not available in this environment');
  }
  await navigator.clipboard.writeText(text);
}
