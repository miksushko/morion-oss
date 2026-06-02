import { describe, it, expect } from 'vitest';
import {
  formatFailureComment,
  humanizeFailureReason,
} from '../src/core/auto-code/workflows/workflow-orchestrator/failure-humanizer.js';

/**
 * Pure-function pin for the runner sentinel → plain-English mapping
 * that powers the failed-run comment. User feedback 2026-05-19:
 * bare sentinels ("interrupted_by_restart", "mo_provider_unconfigured")
 * surfaced as the entire comment body, leaving users with nothing
 * actionable. The humanizer translates known sentinels and falls
 * back to "stopped with an error" + raw block for unknown ones —
 * never drops information.
 */

describe('humanizeFailureReason', () => {
  it('null / empty / whitespace → generic "no reason reported" headline', () => {
    for (const input of [null, '', '   ']) {
      const out = humanizeFailureReason(input);
      expect(out.headline).toContain('without a reported reason');
      expect(out.detail).toBeTruthy();
      expect(out.raw).toBe('(no reason given)');
    }
  });

  it('interrupted_by_restart → sidecar-restart copy', () => {
    const out = humanizeFailureReason('interrupted_by_restart');
    expect(out.headline.toLowerCase()).toContain('sidecar restarted');
    expect(out.detail).toContain('Re-drag the ticket to `todo`');
    expect(out.raw).toBe('interrupted_by_restart');
  });

  it('mo_provider_unconfigured → "Mo isn\'t configured" copy with settings pointer', () => {
    const out = humanizeFailureReason('mo_provider_unconfigured');
    expect(out.headline.toLowerCase()).toContain('mo isn\'t configured');
    expect(out.detail).toContain('Settings → Mo Agent');
  });

  it('worktree_setup_failed:<reason> → surfaces the underlying reason', () => {
    const out = humanizeFailureReason('worktree_setup_failed: fatal: not a git repository');
    expect(out.headline.toLowerCase()).toContain('git worktree');
    expect(out.detail).toContain('not a git repository');
  });

  it('ticket_no_longer_todo → "you moved it" framing (not a real failure)', () => {
    const out = humanizeFailureReason('ticket_no_longer_todo: current status: backlog');
    expect(out.headline).toContain('moved out of `todo`');
    expect(out.detail).toContain('Drag it back to `todo`');
  });

  it('cancelled_during_admission → toggle-off framing', () => {
    const out = humanizeFailureReason('cancelled_during_admission: cancelRequested flag was set');
    expect(out.headline.toLowerCase()).toContain('cancelled during setup');
    expect(out.detail).toContain('Folder Settings → Auto-code');
  });

  it('agent_unavailable / ENOENT → "binary not installed" copy', () => {
    expect(
      humanizeFailureReason('agent_unavailable: pi').headline.toLowerCase(),
    ).toContain('agent binary isn\'t installed');
    expect(
      humanizeFailureReason('spawn pi ENOENT').headline.toLowerCase(),
    ).toContain('agent binary');
  });

  it('budget_exhausted → budget-cap copy', () => {
    const out = humanizeFailureReason('budget_exhausted: stage budget $1.00 reached');
    expect(out.headline.toLowerCase()).toContain('budget cap reached');
    expect(out.detail).toContain('Settings → Limits');
  });

  it('reopen_cap_exhausted → reviewer-loop framing', () => {
    const out = humanizeFailureReason('reopen_cap_exhausted: max 3 attempts');
    expect(out.headline.toLowerCase()).toContain('reviewer kept reopening');
  });

  it('mo_stage_no_verdict → "Mo couldn\'t pick a branch" copy', () => {
    const out = humanizeFailureReason('mo_stage_no_verdict: empty response');
    expect(out.headline.toLowerCase()).toContain('couldn\'t pick a branch');
  });

  it('unknown string → generic "stopped with an error" + raw preserved', () => {
    const raw = 'some_brand_new_sentinel: with details';
    const out = humanizeFailureReason(raw);
    expect(out.headline).toBe('Auto-code stopped with an error');
    expect(out.detail).toBeNull();
    expect(out.raw).toBe(raw);
  });
});

describe('formatFailureComment', () => {
  it('renders headline + detail + tag hint + raw fenced block', () => {
    const reason = humanizeFailureReason('interrupted_by_restart');
    const body = formatFailureComment(reason);
    expect(body).toContain(reason.headline);
    expect(body).toContain(reason.detail!);
    expect(body).toContain('Tagged `auto-code-paused`');
    expect(body).toContain('```\ninterrupted_by_restart\n```');
  });

  it('omits detail paragraph when humanizer left it null (unknown sentinel)', () => {
    const reason = humanizeFailureReason('some_unknown');
    const body = formatFailureComment(reason);
    expect(body).toContain('Auto-code stopped with an error');
    expect(body).toContain('```\nsome_unknown\n```');
    // No double-blank-line orphan from the missing detail.
    expect(body).not.toMatch(/\n\n\n/);
  });

  it('always includes the action hint so the user knows the recovery path', () => {
    for (const raw of [
      'interrupted_by_restart',
      'mo_provider_unconfigured',
      'budget_exhausted',
      'foo_unknown',
      null,
    ]) {
      const body = formatFailureComment(humanizeFailureReason(raw));
      expect(body).toContain('Re-drag to `todo`');
    }
  });
});
