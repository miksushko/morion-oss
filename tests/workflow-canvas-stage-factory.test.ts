import { describe, it, expect } from 'vitest';
import {
  newStageId,
  createDefaultStage,
  readBranches,
  isStagePinned,
} from '../src/web/src/components/canvas/stage-factory';
import type { CanvasStage } from '../src/web/src/components/canvas/types';

describe('canvas/stage-factory — newStageId', () => {
  it('picks `<base><nodeCount+1>` on an empty canvas', () => {
    expect(newStageId('cli_agent', new Set(), 0)).toBe('stage1');
    expect(newStageId('mcp_tool_call', new Set(), 0)).toBe('tool1');
  });

  it('walks past taken ids until it finds a free slot', () => {
    const used = new Set(['stage1', 'stage2', 'stage3']);
    expect(newStageId('cli_agent', used, 2)).toBe('stage4');
  });

  it('uses the right id prefix for each stage kind', () => {
    expect(newStageId('cli_agent', new Set(), 0)).toMatch(/^stage/);
    expect(newStageId('mcp_tool_call', new Set(), 0)).toMatch(/^tool/);
    expect(newStageId('human_gate', new Set(), 0)).toMatch(/^gate/);
    expect(newStageId('mo_stage', new Set(), 0)).toMatch(/^mo/);
    expect(newStageId('mo_router', new Set(), 0)).toMatch(/^mo/);
    expect(newStageId('reject_sink', new Set(), 0)).toMatch(/^reject/);
    expect(newStageId('complete_sink', new Set(), 0)).toMatch(/^complete/);
    expect(newStageId('branch', new Set(), 0)).toMatch(/^branch/);
    expect(newStageId('eject', new Set(), 0)).toMatch(/^eject/);
  });
});

describe('canvas/stage-factory — createDefaultStage', () => {
  it('cli_agent has claude defaults + the standard tool allowlist', () => {
    const s = createDefaultStage('cli_agent', { id: 'x' });
    expect(s.kind).toBe('cli_agent');
    if (s.kind !== 'cli_agent') throw new Error('narrow');
    expect(s.agent).toBe('claude');
    expect(s.allowedTools).toContain('Read');
    expect(s.allowedTools).toContain('Bash');
    expect(s.maxBudgetUsd).toBe(1);
    expect(s.maxAttempts).toBe(1);
  });

  it('mcp_tool_call defaults to mo_ask with a question template', () => {
    const s = createDefaultStage('mcp_tool_call', { id: 'x' });
    if (s.kind !== 'mcp_tool_call') throw new Error('narrow');
    expect(s.toolName).toBe('mo_ask');
    expect(s.argsTemplate).toBeDefined();
  });

  it('human_gate uses the legacy `prompt` field with friendly copy', () => {
    const s = createDefaultStage('human_gate', { id: 'x' });
    if (s.kind !== 'human_gate') throw new Error('narrow');
    expect(s.prompt).toBeTruthy();
  });

  it('mo_stage auto-flags isStart when no Process Start exists yet', () => {
    const fresh = createDefaultStage('mo_stage', { id: 'm1', hasExistingStart: false });
    if (fresh.kind !== 'mo_stage') throw new Error('narrow');
    expect(fresh.isStart).toBe(true);
    expect(fresh.branches).toHaveLength(2);
    expect(fresh.branches).toContain('approve');
    expect(fresh.branches).toContain('reject');
  });

  it('mo_stage skips isStart when a Process Start is already present', () => {
    const second = createDefaultStage('mo_stage', { id: 'm2', hasExistingStart: true });
    if (second.kind !== 'mo_stage') throw new Error('narrow');
    expect(second.isStart).toBe(false);
  });

  it('terminal sinks have empty commentTemplate placeholder', () => {
    const r = createDefaultStage('reject_sink', { id: 'r' });
    if (r.kind !== 'reject_sink') throw new Error('narrow');
    expect(r.commentTemplate).toBe('');
    const c = createDefaultStage('complete_sink', { id: 'c' });
    if (c.kind !== 'complete_sink') throw new Error('narrow');
    expect(c.commentTemplate).toBe('');
  });

  it('branch ships with combinator=all + one default condition', () => {
    const s = createDefaultStage('branch', { id: 'b' });
    if (s.kind !== 'branch') throw new Error('narrow');
    expect(s.combinator).toBe('all');
    expect(s.conditions).toHaveLength(1);
  });

  it('every default stage carries the requested id', () => {
    const kinds: CanvasStage['kind'][] = [
      'cli_agent',
      'mcp_tool_call',
      'human_gate',
      'mo_stage',
      'mo_router',
      'reject_sink',
      'complete_sink',
      'branch',
      'eject',
    ];
    for (const k of kinds) {
      expect(createDefaultStage(k, { id: 'pinned-id' }).id).toBe('pinned-id');
    }
  });
});

describe('canvas/stage-factory — readBranches', () => {
  it('returns branch list copy for mo_stage', () => {
    const result = readBranches({
      id: 'm',
      kind: 'mo_stage',
      instruction: '',
      branches: ['a', 'b'],
    });
    expect(result).toEqual(['a', 'b']);
  });

  it('returns branch list copy for mo_router', () => {
    expect(
      readBranches({
        id: 'r',
        kind: 'mo_router',
        prompt: '',
        branches: ['x', 'y', 'z'],
      }),
    ).toEqual(['x', 'y', 'z']);
  });

  it('returns null for non-routing stages', () => {
    expect(
      readBranches({
        id: 's',
        kind: 'cli_agent',
        agent: 'claude',
        promptTemplate: '',
      }),
    ).toBeNull();
    expect(readBranches({ id: 'r', kind: 'reject_sink' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(readBranches(null)).toBeNull();
  });

  it('returns a copy (not the same array) so the caller can mutate', () => {
    const stage: CanvasStage = {
      id: 'm',
      kind: 'mo_stage',
      instruction: '',
      branches: ['a', 'b'],
    };
    const result = readBranches(stage);
    expect(result).not.toBe(stage.branches);
  });
});

describe('canvas/stage-factory — isStagePinned', () => {
  it('Process Start mo_stage is pinned', () => {
    expect(
      isStagePinned({
        id: 'm',
        kind: 'mo_stage',
        instruction: '',
        branches: ['a', 'b'],
        isStart: true,
      }),
    ).toBe(true);
  });

  it('regular mo_stage (no isStart) is NOT pinned', () => {
    expect(
      isStagePinned({
        id: 'm',
        kind: 'mo_stage',
        instruction: '',
        branches: ['a', 'b'],
      }),
    ).toBe(false);
  });

  it('reject_sink + complete_sink are pinned', () => {
    expect(isStagePinned({ id: 'r', kind: 'reject_sink' })).toBe(true);
    expect(isStagePinned({ id: 'c', kind: 'complete_sink' })).toBe(true);
  });

  it('cli_agent / mcp_tool_call / human_gate / branch / eject / mo_router are NOT pinned', () => {
    expect(
      isStagePinned({ id: 'a', kind: 'cli_agent', agent: 'claude', promptTemplate: '' }),
    ).toBe(false);
    expect(
      isStagePinned({ id: 'b', kind: 'mcp_tool_call', toolName: 'x' }),
    ).toBe(false);
    expect(isStagePinned({ id: 'c', kind: 'human_gate' })).toBe(false);
    expect(
      isStagePinned({
        id: 'd',
        kind: 'branch',
        conditions: [],
      }),
    ).toBe(false);
    expect(isStagePinned({ id: 'e', kind: 'eject', reason: '' })).toBe(false);
    expect(
      isStagePinned({
        id: 'f',
        kind: 'mo_router',
        prompt: '',
        branches: ['x', 'y'],
      }),
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStagePinned(null)).toBe(false);
  });
});
