/**
 * Auto-code CLI Agent Harness — public API surface.
 *
 * The harness is a runtime-agnostic adapter layer for spawning CLI
 * coding agents (claude / codex / pi / opencode) and observing them
 * through a uniform `CliAgentEvent` stream. Higher-level workflow
 * orchestration (workflow_runs, ticket chat, ask_user routing) lives
 * in L2+ and consumes this layer through the types exported here.
 *
 * Design doc: Morion note `01KR5TMKE9GZGXTQ2BCTWCXVD5` §3.
 * Umbrella epic: `01KR5F21709BKA6SFHWRFFVVPY`.
 */

// Event taxonomy
export type {
  AgentName,
  BaseEvent,
  CliAgentEvent,
  SessionStartEvent,
  TextDeltaEvent,
  MessageEvent,
  ToolStartEvent,
  ToolEndEvent,
  ResultEvent,
  ErrorEvent,
  CancelRequestedEvent,
} from './events.js';
export {
  isTerminalEvent,
  isResult,
  isError,
  isSessionStart,
} from './events.js';

// Adapter contract
export type {
  CliAgentAdapter,
  AgentHandle,
  SpawnOptions,
} from './adapter.js';
export {
  AgentHarnessError,
  AgentBinaryNotFoundError,
  AgentSpawnError,
  AgentResumeUnsupportedError,
  AgentRequiredPackageMissingError,
} from './adapter.js';

// Runtime parsing (Zod schemas + helpers). Adapters import these to
// validate stdout from their underlying CLI; type-only consumers
// don't pay the Zod cost (kept in a separate module from `events.ts`).
export {
  CliAgentEventSchema,
  parseEventLine,
  parseEventObject,
} from './events-parse.js';

// Adapter implementations. Each adapter is its own export — callers
// instantiate via `new ClaudeAdapter()` etc.
export { ClaudeAdapter, type ClaudeAdapterOptions } from './adapters/claude.js';
export { CodexAdapter, type CodexAdapterOptions } from './adapters/codex.js';
export {
  PiAdapter,
  type PiAdapterOptions,
  type PiAgentConfig,
} from './adapters/pi.js';
export {
  OpencodeAdapter,
  type OpencodeAdapterOptions,
} from './adapters/opencode.js';

// Transcript file persistence (L1.T8). Adapters get this
// transparently when caller supplies `transcriptDir` in
// `AbstractHandleParams`; standalone helpers are exported for the
// L2 UI drawer (`readTranscript`) and L3 retention pruning (paths
// via `transcriptPathFor`).
export {
  TranscriptWriter,
  readTranscript,
  transcriptPathFor,
} from './transcript.js';
