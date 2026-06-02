import type { GatherInput } from '../types.js';
import type { BootstrapState } from './bootstrap-state.js';
import type { Wave1Output, Wave2Output } from './wave-types.js';
import { truncate } from './helpers.js';

/**
 * Assemble the prompt scope passed to the gather-synthesizer sub-Mo.
 *
 * The synthesizer expects a single string containing every signal
 * the gather pipeline accumulated, formatted as Markdown sections.
 * Order + section headers are part of the prompt contract — the
 * sub-Mo role's instructions name them explicitly. Sections are
 * omitted entirely (no blank stub) when the corresponding source is
 * empty so the synthesizer doesn't waste tokens parsing placeholders.
 *
 * Pure function: no I/O, no LLM call, no mutation of inputs. Easy
 * fixture-based testing (see tests/mo-gather-synthesizer-input.test.ts).
 */
export function buildSynthesizerInput(args: {
  input: GatherInput;
  bootstrap: BootstrapState;
  wave1: Wave1Output;
  wave2: Wave2Output;
  workspaceMemory: string | null;
}): string {
  const { input, bootstrap, wave1, wave2, workspaceMemory } = args;
  const lines: string[] = [];

  if (workspaceMemory) {
    // Workspace-wide Mo memory — durable user preferences /
    // conventions / form-of-address that should colour every
    // synthesis. Read fresh per call by `gatherContext`.
    lines.push('# Mo memory (workspace-wide)');
    lines.push(workspaceMemory);
    lines.push('');
  }

  lines.push('# Agent\'s task or question');
  if (input.taskId) {
    lines.push(`taskId: ${input.taskId}`);
    lines.push(`title: ${bootstrap.taskTitle ?? '(untitled)'}`);
    lines.push(`folder: ${bootstrap.folderId ?? '(unfiled)'}`);
    lines.push(`body:`);
    lines.push(truncate(bootstrap.taskBody ?? '', 2000));
    if (bootstrap.metadataSummary) {
      lines.push('');
      lines.push(`Mo summary: ${bootstrap.metadataSummary}`);
    }
  } else {
    lines.push(`question: ${input.question}`);
    if (input.folderId) lines.push(`folder: ${input.folderId}`);
  }

  if (bootstrap.comments.length > 0) {
    lines.push('');
    lines.push(`# Recent comments on the task (${bootstrap.comments.length})`);
    for (const c of bootstrap.comments.slice(0, 5)) {
      lines.push(`- ${c.actor}: ${truncate(c.body, 300)}`);
    }
  }

  if (wave1.keywords.length > 0) {
    lines.push('');
    lines.push(`# Keywords distilled from the task / question`);
    lines.push(wave1.keywords.join(', '));
  }

  if (wave1.clusterFindings.length > 0) {
    lines.push('');
    lines.push(`# Cluster-analyst findings (Wave 1)`);
    for (const f of wave1.clusterFindings) {
      lines.push(`- cluster \`${f.clusterId}\`: ${f.why}`);
      if (f.drillIntoNoteIds.length > 0) {
        lines.push(`  picked notes: ${f.drillIntoNoteIds.join(', ')}`);
      }
    }
  }

  if (wave2.bodyExtractions.length > 0) {
    lines.push('');
    lines.push(`# Body extractions (Wave 2)`);
    for (const e of wave2.bodyExtractions) {
      lines.push(`## [${e.noteId}] ${e.title}${e.isWarning ? ' ⚠ WARNING' : ''}`);
      lines.push(`why: ${e.why}`);
      for (const chunk of e.chunks) {
        lines.push(`> ${chunk}`);
      }
    }
  }

  if (wave2.workspaceCandidates.length > 0) {
    lines.push('');
    lines.push(`# Workspace search candidates (not drilled into)`);
    for (const c of wave2.workspaceCandidates) {
      lines.push(`- [${c.noteId}] ${c.title} (folder: ${c.folderId ?? 'unfiled'})${c.summary ? ` — ${truncate(c.summary, 200)}` : ''}`);
    }
  }

  return lines.join('\n');
}
