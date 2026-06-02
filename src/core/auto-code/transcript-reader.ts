/**
 * Auto-code Phase 3 — transcript reader (barrel).
 *
 * Originally a single 611-LOC file. Re-split 2026-05-16 (ticket
 * `01KRQYRTY348DAG9MM6JPMTDYR`) into per-domain modules under
 * `./transcript-reader/`. Existing importers (auto-code-queue route +
 * the dedicated test) keep their `from '.../transcript-reader.js'`
 * import path unchanged — this barrel re-exports the public surface.
 *
 * Reads the per-session JSONL transcripts that the Claude Code CLI
 * writes under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * AND the unified CliAgentEvent JSONL the workflow runner writes
 * under `~/.morion/runs/<sessionId>.jsonl`. Output is a single
 * `TranscriptMessage[]` shape the AutoCodeDrawer consumes either way.
 */

export {
  encodeCwdForClaudeProjects,
  transcriptDir,
  transcriptPath,
} from './transcript-reader/paths.js';
export {
  parseTranscriptText,
  parseTranscriptFile,
} from './transcript-reader/parse-claude.js';
export {
  parseHarnessTranscriptText,
  parseHarnessTranscriptFile,
} from './transcript-reader/parse-harness.js';
export {
  watchTranscript,
  type WatchHandle,
} from './transcript-reader/watch.js';
export type {
  TranscriptMessage,
  TranscriptMessageKind,
  ParseTranscriptResult,
} from './transcript-reader/types.js';
