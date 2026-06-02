import { describe, expect, it } from 'vitest';

import {
  resolveConflictsWithAI,
  stripFences,
  type MergeResolverFile,
} from '../src/core/auto-code/merge-resolver-ai.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/core/concierge/provider.js';

/**
 * Unit tests for the AI merge-conflict resolver. Mock provider lets
 * us script per-model responses + verify the fallback / leftover-
 * marker rejection paths.
 */

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly calls: LLMRequest[] = [];
  constructor(
    private readonly script: Record<
      string,
      LLMResponse | { throw: string } | LLMResponse[]
    >,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const entry = this.script[req.model];
    if (!entry) {
      throw new Error(`no scripted response for model "${req.model}"`);
    }
    if (Array.isArray(entry)) {
      const next = entry.shift();
      if (!next) throw new Error(`scripted array empty for model "${req.model}"`);
      return next;
    }
    if ('throw' in entry) {
      throw new Error(entry.throw);
    }
    return entry;
  }
}

function makeResponse(content: string, costUsd = 0.005): LLMResponse {
  return {
    content,
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    costUsd,
    model: 'scripted',
  };
}

const SAMPLE_FILE: MergeResolverFile = {
  path: 'game.js',
  ours: 'console.log("main");\n',
  theirs: 'console.log("feature");\n',
  merged:
    'console.log("v1");\n<<<<<<< HEAD\nconsole.log("main");\n=======\nconsole.log("feature");\n>>>>>>> feature\n',
};

const TICKET = { title: 'Add feature', bodyExcerpt: 'Replace v1 logging' };
const BRANCHES = { targetBranch: 'main', worktreeBranch: 'auto-test' };

describe('merge-resolver-ai', () => {
  describe('stripFences', () => {
    it('strips a triple-backtick fence wrap', () => {
      expect(stripFences('```js\nconsole.log(1);\n```')).toBe('console.log(1);');
    });

    it('strips leading commentary lines like "Here is the resolved..."', () => {
      const raw = "Here is the resolved file:\nconsole.log(1);";
      expect(stripFences(raw)).toBe('console.log(1);');
    });

    it("leaves clean output alone", () => {
      expect(stripFences('console.log(1);\n')).toBe('console.log(1);');
    });
  });

  describe('resolveConflictsWithAI', () => {
    it('happy path: primary returns clean content → ok with modelUsed=primary', async () => {
      const provider = new ScriptedProvider({
        primary: makeResponse('console.log("merged-by-ai");\n'),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: 'fallback',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      expect(r.results.length).toBe(1);
      const first = r.results[0]!;
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.modelUsed).toBe('primary');
      expect(first.content).toContain('merged-by-ai');
      expect(r.okCount).toBe(1);
      expect(r.failedCount).toBe(0);
      expect(r.anyFallback).toBe(false);
      expect(provider.calls.length).toBe(1);
    });

    it('primary returns leftover markers → fallback fires and succeeds', async () => {
      const provider = new ScriptedProvider({
        primary: makeResponse(
          '<<<<<<< HEAD\nconsole.log("main");\n=======\nconsole.log("feature");\n>>>>>>> feature\n',
        ),
        fallback: makeResponse('console.log("merged-via-fallback");\n', 0.02),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: 'fallback',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      const first = r.results[0]!;
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.modelUsed).toBe('fallback');
      expect(first.content).toContain('merged-via-fallback');
      expect(first.costUsd).toBeGreaterThan(0.02); // sum primary + fallback
      expect(r.anyFallback).toBe(true);
      expect(provider.calls.length).toBe(2);
    });

    it('primary throws → fallback fires', async () => {
      const provider = new ScriptedProvider({
        primary: { throw: 'rate limit' },
        fallback: makeResponse('console.log("recovered");\n'),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: 'fallback',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      const first = r.results[0]!;
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.modelUsed).toBe('fallback');
    });

    it('primary AND fallback return markers → failure surfaced', async () => {
      const provider = new ScriptedProvider({
        primary: makeResponse(
          '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> b\n',
        ),
        fallback: makeResponse(
          '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> b\n',
          0.02,
        ),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: 'fallback',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      const first = r.results[0]!;
      expect(first.ok).toBe(false);
      if (first.ok) return;
      expect(first.reason).toBe('fallback_markers_only');
      expect(first.costUsd).toBeGreaterThan(0); // primary + fallback both billed
    });

    it('no fallback configured → primary failure is final', async () => {
      const provider = new ScriptedProvider({
        primary: makeResponse(
          '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> b\n',
        ),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: '',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      const first = r.results[0]!;
      expect(first.ok).toBe(false);
      if (first.ok) return;
      expect(first.reason).toBe('primary_markers_only');
    });

    it('per-call cost cap fires when primary cost exceeds MAX_PER_FILE_COST_USD', async () => {
      const provider = new ScriptedProvider({
        primary: makeResponse('console.log("ok");\n', 5.0),
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: '',
        files: [SAMPLE_FILE],
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      const first = r.results[0]!;
      expect(first.ok).toBe(false);
      if (first.ok) return;
      expect(first.reason).toBe('budget_exceeded');
    });

    it('parallel resolution: 3 files in one batch fire 3 model calls', async () => {
      const provider = new ScriptedProvider({
        primary: [
          makeResponse('console.log("a");\n'),
          makeResponse('console.log("b");\n'),
          makeResponse('console.log("c");\n'),
        ],
      });
      const files = ['a.js', 'b.js', 'c.js'].map((path) => ({
        ...SAMPLE_FILE,
        path,
      }));
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: '',
        files,
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      expect(r.okCount).toBe(3);
      expect(r.results.map((x) => x.path)).toEqual(['a.js', 'b.js', 'c.js']);
      expect(provider.calls.length).toBe(3);
    });

    it('mixed success / failure preserves per-file ordering', async () => {
      const provider = new ScriptedProvider({
        primary: [
          makeResponse('console.log("a-ok");\n'),
          makeResponse('<<<<<<< HEAD\nbad\n=======\nbad\n>>>>>>> b\n'),
          makeResponse('console.log("c-ok");\n'),
        ],
      });
      const r = await resolveConflictsWithAI({
        provider,
        primaryModel: 'primary',
        fallbackModel: '',
        files: ['a', 'b', 'c'].map((path) => ({ ...SAMPLE_FILE, path })),
        ticketContext: TICKET,
        branches: BRANCHES,
      });
      expect(r.okCount).toBe(2);
      expect(r.failedCount).toBe(1);
      expect(r.results[0]!.ok).toBe(true);
      expect(r.results[1]!.ok).toBe(false);
      expect(r.results[2]!.ok).toBe(true);
    });
  });
});
