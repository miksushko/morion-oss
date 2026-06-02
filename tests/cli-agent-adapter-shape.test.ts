import { describe, it, expect } from 'vitest';
import {
  type AgentHandle,
  type AgentName,
  type CliAgentAdapter,
  type CliAgentEvent,
  type ErrorEvent,
  type ResultEvent,
  type SessionStartEvent,
  type SpawnOptions,
  AgentBinaryNotFoundError,
  AgentHarnessError,
  AgentRequiredPackageMissingError,
  AgentResumeUnsupportedError,
  AgentSpawnError,
  isError,
  isResult,
  isSessionStart,
  isTerminalEvent,
} from '../src/core/auto-code/harness/index.js';

/**
 * L1.T1 — pin the harness interface contract. Implementations land in
 * L1.T3-T6. This suite verifies:
 *
 *   1. The shape compiles and exports cleanly (TS check enforced by
 *      `npm run build`; runtime construction below pins discriminator
 *      and field placement).
 *   2. Error classes are constructible, distinguishable via
 *      `instanceof`, and carry the documented `errorKind`.
 *   3. Type guards narrow correctly.
 *
 * No implementation files are exercised; the test only constructs
 * sample types and asserts on their runtime shape. The harness module
 * itself is types-only at this layer.
 */

describe('CliAgentAdapter contract (L1.T1)', () => {
  describe('SpawnOptions shape', () => {
    it('accepts the documented full field set', () => {
      const controller = new AbortController();
      const opts: SpawnOptions = {
        prompt: 'do the thing',
        cwd: '/tmp/work',
        sessionId: 'sess-123',
        allowedTools: ['Read', 'Bash', 'Edit'],
        model: 'claude-opus-4-7',
        maxBudgetUsd: 0.5,
        timeoutMs: 30 * 60 * 1000,
        env: { CUSTOM: 'value' },
        signal: controller.signal,
        agentConfig: { provider: 'ollama', requiredPackages: ['pi-mcp-adapter'] },
      };
      expect(opts.prompt).toBe('do the thing');
      expect(opts.allowedTools).toEqual(['Read', 'Bash', 'Edit']);
      expect(opts.maxBudgetUsd).toBe(0.5);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('accepts the minimal field set (only prompt + cwd)', () => {
      const opts: SpawnOptions = { prompt: 'hi', cwd: '/tmp' };
      expect(opts.cwd).toBe('/tmp');
      expect(opts.sessionId).toBeUndefined();
    });
  });

  describe('AgentName + event discriminators', () => {
    it('SessionStartEvent carries sessionId + agent + timestamp', () => {
      const ev: SessionStartEvent = {
        kind: 'session_start',
        sessionId: 'abc-123',
        agent: 'claude',
        timestamp: Date.now(),
      };
      expect(ev.kind).toBe('session_start');
      expect(ev.agent).toBe('claude');
    });

    it('all four v1 agent names are assignable', () => {
      const names: AgentName[] = ['claude', 'codex', 'pi', 'opencode'];
      expect(names).toHaveLength(4);
    });

    it('ResultEvent is terminal with cost + terminalReason', () => {
      const ev: ResultEvent = {
        kind: 'result',
        exitCode: 0,
        summary: 'done',
        costUsd: 0.012,
        terminalReason: 'completed',
        timestamp: Date.now(),
      };
      expect(ev.exitCode).toBe(0);
      expect(ev.costUsd).toBeCloseTo(0.012);
      expect(ev.terminalReason).toBe('completed');
    });

    it('ResultEvent terminalReason discriminates budget cap', () => {
      const ev: ResultEvent = {
        kind: 'result',
        exitCode: 0,
        summary: 'stopped at cap',
        costUsd: 0.5,
        terminalReason: 'budget',
        timestamp: Date.now(),
      };
      expect(ev.terminalReason).toBe('budget');
    });

    it('ErrorEvent carries errorKind + recoverable flag', () => {
      const ev: ErrorEvent = {
        kind: 'error',
        errorKind: 'codex_ink_crash',
        message: 'codex 0.1.x rawmode failure',
        recoverable: true,
        timestamp: Date.now(),
      };
      expect(ev.recoverable).toBe(true);
      expect(ev.errorKind).toBe('codex_ink_crash');
    });

    it('CancelRequestedEvent carries a reason string', () => {
      const ev: CliAgentEvent = {
        kind: 'cancel_requested',
        reason: 'user_toggle_off',
        timestamp: Date.now(),
      };
      expect(ev.kind).toBe('cancel_requested');
    });
  });

  describe('type guards', () => {
    const sessionStart: CliAgentEvent = {
      kind: 'session_start',
      sessionId: 's',
      agent: 'pi',
      timestamp: 1,
    };
    const result: CliAgentEvent = {
      kind: 'result',
      exitCode: 0,
      summary: '',
      costUsd: 0,
      terminalReason: 'completed',
      timestamp: 2,
    };
    const error: CliAgentEvent = {
      kind: 'error',
      errorKind: 'timeout',
      message: 'wall clock exceeded',
      recoverable: false,
      timestamp: 3,
    };
    const textDelta: CliAgentEvent = {
      kind: 'text_delta',
      text: 'hello',
      timestamp: 4,
    };

    it('isSessionStart narrows correctly', () => {
      expect(isSessionStart(sessionStart)).toBe(true);
      expect(isSessionStart(result)).toBe(false);
      expect(isSessionStart(textDelta)).toBe(false);
    });

    it('isResult narrows correctly', () => {
      expect(isResult(result)).toBe(true);
      expect(isResult(error)).toBe(false);
      expect(isResult(textDelta)).toBe(false);
    });

    it('isError narrows correctly', () => {
      expect(isError(error)).toBe(true);
      expect(isError(result)).toBe(false);
      expect(isError(textDelta)).toBe(false);
    });

    it('isTerminalEvent matches result OR error, not anything else', () => {
      expect(isTerminalEvent(result)).toBe(true);
      expect(isTerminalEvent(error)).toBe(true);
      expect(isTerminalEvent(sessionStart)).toBe(false);
      expect(isTerminalEvent(textDelta)).toBe(false);
    });
  });

  describe('error hierarchy', () => {
    it('AgentHarnessError is the base, carries errorKind', () => {
      const err = new AgentHarnessError('custom_kind', 'oops');
      expect(err).toBeInstanceOf(Error);
      expect(err.errorKind).toBe('custom_kind');
      expect(err.message).toBe('oops');
      expect(err.name).toBe('AgentHarnessError');
    });

    it('AgentHarnessError preserves cause', () => {
      const cause = new Error('underlying');
      const err = new AgentHarnessError('x', 'wrap', cause);
      expect(err.cause).toBe(cause);
    });

    it('AgentBinaryNotFoundError lists candidate paths', () => {
      const err = new AgentBinaryNotFoundError('pi', [
        '/usr/bin/pi',
        '/opt/pi/bin/pi',
      ]);
      expect(err).toBeInstanceOf(AgentHarnessError);
      expect(err.errorKind).toBe('binary_not_found');
      expect(err.agent).toBe('pi');
      expect(err.lookedAt).toEqual(['/usr/bin/pi', '/opt/pi/bin/pi']);
      expect(err.message).toContain('/usr/bin/pi');
    });

    it('AgentSpawnError wraps a cause', () => {
      const cause = new Error('EACCES');
      const err = new AgentSpawnError('cwd not writable', cause);
      expect(err.cause).toBe(cause);
      expect(err.errorKind).toBe('spawn_failed');
    });

    it('AgentResumeUnsupportedError names the agent', () => {
      const err = new AgentResumeUnsupportedError(
        'codex',
        'codex 0.1.x has no --resume',
      );
      expect(err.errorKind).toBe('agent_resume_unsupported');
      expect(err.agent).toBe('codex');
      expect(err.message).toContain('codex');
      expect(err.message).toContain('0.1.x');
    });

    it('AgentRequiredPackageMissingError surfaces install hint', () => {
      const err = new AgentRequiredPackageMissingError(
        'pi',
        ['pi-mcp-adapter'],
        'pi install npm:pi-mcp-adapter',
      );
      expect(err.errorKind).toBe('required_package_missing');
      expect(err.missingPackages).toEqual(['pi-mcp-adapter']);
      expect(err.installHint).toBe('pi install npm:pi-mcp-adapter');
      expect(err.message).toContain('pi-mcp-adapter');
      expect(err.message).toContain('pi install npm:');
    });

    it('errors are distinguishable via instanceof chain', () => {
      const err = new AgentBinaryNotFoundError('claude', ['/usr/bin/claude']);
      expect(err instanceof AgentBinaryNotFoundError).toBe(true);
      expect(err instanceof AgentHarnessError).toBe(true);
      expect(err instanceof Error).toBe(true);
      // Cross-checks: not instances of sibling errors.
      expect(err instanceof AgentResumeUnsupportedError).toBe(false);
      expect(err instanceof AgentSpawnError).toBe(false);
      expect(err instanceof AgentRequiredPackageMissingError).toBe(false);
    });

    it('errorKind on thrown error matches what an event would carry', () => {
      // Invariant: spawn-time error class kinds align 1:1 with the
      // ErrorEvent.errorKind values listed in events.ts JSDoc. This
      // lets calling code switch on errorKind once for both paths.
      const cases: Array<[AgentHarnessError, string]> = [
        [new AgentBinaryNotFoundError('claude', ['/x']), 'binary_not_found'],
        [new AgentSpawnError('bad cwd'), 'spawn_failed'],
        [new AgentResumeUnsupportedError('codex'), 'agent_resume_unsupported'],
        [
          new AgentRequiredPackageMissingError('pi', ['p'], 'pi install npm:p'),
          'required_package_missing',
        ],
      ];
      for (const [err, expected] of cases) {
        expect(err.errorKind).toBe(expected);
      }
    });
  });

  describe('AgentHandle / CliAgentAdapter — structural usability', () => {
    /**
     * The harness is types-only at L1.T1. We construct a minimal
     * mock adapter + handle here purely to prove the interfaces are
     * implementable as documented. Real adapters (claude/codex/pi/
     * opencode) implement the same contract in L1.T3-T6.
     */
    function makeMockHandle(): AgentHandle {
      const events: CliAgentEvent[] = [
        { kind: 'session_start', sessionId: 'mock', agent: 'claude', timestamp: 1 },
        {
          kind: 'result',
          exitCode: 0,
          summary: 'ok',
          costUsd: 0,
          terminalReason: 'completed',
          timestamp: 2,
        },
      ];
      return {
        adapter: 'claude',
        sessionId: 'mock',
        pid: 12345,
        events: (async function* () {
          for (const ev of events) yield ev;
        })(),
        exited: Promise.resolve(),
        cancel: async () => undefined,
        resume: async () => makeMockHandle(),
        getCost: () => 0,
      };
    }

    it('a handle can be implemented with the documented surface', async () => {
      const handle = makeMockHandle();
      expect(handle.adapter).toBe('claude');
      expect(handle.sessionId).toBe('mock');
      expect(handle.pid).toBe(12345);
      expect(handle.getCost()).toBe(0);

      const collected: CliAgentEvent[] = [];
      for await (const ev of handle.events) collected.push(ev);
      expect(collected).toHaveLength(2);
      expect(isSessionStart(collected[0]!)).toBe(true);
      expect(isResult(collected[1]!)).toBe(true);

      await handle.cancel('user_toggle_off');
      const resumed = await handle.resume('continue');
      expect(resumed.adapter).toBe('claude');
    });

    it('an adapter can be implemented as documented', async () => {
      const adapter: CliAgentAdapter = {
        name: 'claude',
        spawn: async (_opts: SpawnOptions) => makeMockHandle(),
      };
      const handle = await adapter.spawn({ prompt: 'p', cwd: '/tmp' });
      expect(handle.adapter).toBe('claude');
      expect(adapter.name).toBe('claude');
    });
  });
});
