/**
 * Opencode adapter configuration types. Extracted from `../opencode.ts`
 * (2026-05-16, ticket `01KRQYRA9...` mirror of codex split).
 */

import type { AbstractHandleParams } from '../../abstract-handle-types.js';

export interface OpencodeAdapterOptions {
  /** Override binary path. Resolution: this option →
   *  `MORION_OPENCODE_BIN` env var → `which opencode` on PATH. */
  binPath?: string;
}

export interface HandleParams extends AbstractHandleParams {
  mode: 'fresh' | 'resume';
  model?: string;
}
