import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime, type Runtime } from '../../src/core/runtime.js';
import {
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  MoIndexingProvider,
  MoIndexingTickDeps,
} from '../../src/core/concierge/index.js';

/**
 * Shared QA harness for the Mo Indexing integration suites
 * (originally inlined in tests/qa/mo-indexing-integration.test.ts
 * before the 2026-05-16 split — Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9).
 *
 * Drives the full pipeline against an on-disk SQLite database wired
 * through `buildRuntime` (production path). LLM is stubbed at the
 * provider layer — everything before and after the LLM call is real
 * production code.
 *
 * Test cases match `tasks/qa-mo-indexing.md` 1:1 — each scenario
 * prints a one-line pass marker so the test output reads like a QA
 * report.
 */

export interface StubResponseSpec {
  content?: string;
  costUsd?: number;
  throwError?: Error;
}

export class StubProvider implements LLMProvider {
  readonly name = 'qa-stub';
  public calls: LLMRequest[] = [];
  constructor(private readonly responder: () => StubResponseSpec) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const spec = this.responder();
    if (spec.throwError) throw spec.throwError;
    return {
      content: spec.content ?? '',
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: spec.costUsd ?? 0.0001,
      model: req.model,
    };
  }
}

export const tier1Json = JSON.stringify({
  summary: 'A QA-driven note exercising the Tier 1 pipeline.',
  keywords: ['qa', 'tier1', 'integration'],
  cluster_candidates: [
    { cluster_id: 'qa-pipeline', confidence: 0.92 },
    { cluster_id: 'mo-tier1', confidence: 0.7 },
  ],
});

export const longBody = (tag: string) =>
  `# ${tag}\n\nThis ticket has substantial body content well above the Tier 1 minimum (>30 chars). Tag=${tag}. Background context for indexing.`;

export interface QaCtx {
  rt: Runtime;
  configDir: string;
  cleanup: () => void;
}

export function setupQa(): QaCtx {
  const configDir = mkdtempSync(join(tmpdir(), 'morion-qa-'));
  const dbPath = join(configDir, 'morion.db');
  const rt = buildRuntime({
    dbPath,
    httpPort: 0,
    httpHost: '127.0.0.1',
    embeddings: { provider: 'noop', model: 'noop' },
  } as Runtime['config']);
  return {
    rt,
    configDir,
    cleanup: () => {
      rt.handle.db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

export function buildIndexingDeps(
  rt: Runtime,
  resolveProvider: () => MoIndexingProvider | null,
): MoIndexingTickDeps {
  return {
    db: rt.handle.db,
    notes: rt.notes,
    folders: rt.folders,
    workspaceSettings: rt.settings,
    folderSettings: rt.concierge.folderSettings,
    metaRepo: rt.concierge.moMetadata,
    clustersRepo: rt.concierge.moClusters,
    metadataQueue: rt.concierge.moMetadataQueue,
    clusterQueue: rt.concierge.moClusterQueue,
    budget: rt.concierge.budget,
    resolveProvider,
  };
}

export function defaultProvider(stub: StubProvider): MoIndexingProvider {
  return {
    provider: stub,
    tier1Model: MO_INDEXING_TIER1_MODEL,
    tier1FallbackModel: MO_INDEXING_TIER1_FALLBACK,
    tier2Model: 'qwen/qwen3-235b-a22b-2507',
    tier2FallbackModel: 'mistralai/mistral-small-24b-instruct-2501',
  };
}
