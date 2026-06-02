import { describe, it, expect } from 'vitest';
import { buildSynthesizerInput } from '../src/core/concierge/context/gather/synthesize.ts';
import type { BootstrapState } from '../src/core/concierge/context/gather/bootstrap-state.ts';
import type {
  Wave1Output,
  Wave2Output,
} from '../src/core/concierge/context/gather/wave-types.ts';
import type { GatherInput } from '../src/core/concierge/context/types.ts';

const mkBootstrap = (over: Partial<BootstrapState> = {}): BootstrapState => ({
  taskId: '01TASKXXX',
  folderId: '01FOLDERX',
  taskBodyHash: 'h',
  folderCatalogHash: 'c',
  clusterIds: [],
  taskBody: 'task body content',
  taskTitle: 'A task',
  metadataSummary: null,
  metadataKeywords: [],
  comments: [],
  audit: [],
  ...over,
});

const mkWave1 = (over: Partial<Wave1Output> = {}): Wave1Output => ({
  keywords: [],
  clusterFindings: [],
  spentUsd: 0,
  warnings: [],
  ...over,
});

const mkWave2 = (over: Partial<Wave2Output> = {}): Wave2Output => ({
  bodyExtractions: [],
  workspaceCandidates: [],
  spentUsd: 0,
  warnings: [],
  ...over,
});

const taskInput: GatherInput = { taskId: '01TASKXXX', folderId: '01FOLDERX' };
const questionInput: GatherInput = { question: 'why is the sky blue?' };

describe('buildSynthesizerInput — top-level structure', () => {
  it('always emits the agent header for task path', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain("# Agent's task or question");
    expect(out).toContain('taskId: 01TASKXXX');
    expect(out).toContain('title: A task');
    expect(out).toContain('folder: 01FOLDERX');
    expect(out).toContain('body:');
    expect(out).toContain('task body content');
  });

  it('emits question-mode block when no taskId', () => {
    const out = buildSynthesizerInput({
      input: questionInput,
      bootstrap: mkBootstrap({ taskId: null, taskTitle: null, taskBody: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('question: why is the sky blue?');
    expect(out).not.toContain('taskId:');
    expect(out).not.toContain('title:');
    expect(out).not.toContain('body:');
  });

  it('includes folder line in question-mode only when input.folderId set', () => {
    const withFolder = buildSynthesizerInput({
      input: { question: 'q', folderId: '01F' },
      bootstrap: mkBootstrap({ taskId: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(withFolder).toContain('folder: 01F');

    const withoutFolder = buildSynthesizerInput({
      input: { question: 'q' },
      bootstrap: mkBootstrap({ taskId: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(withoutFolder).not.toContain('folder:');
  });

  it('renders (untitled) fallback when taskTitle is null', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ taskTitle: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('title: (untitled)');
  });

  it('renders (unfiled) fallback when folderId is null', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ folderId: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('folder: (unfiled)');
  });
});

describe('buildSynthesizerInput — workspace memory', () => {
  it('emits memory block when present, before the agent header', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: 'Address user formally. Prefer TypeScript.',
    });
    const memoryIdx = out.indexOf('# Mo memory (workspace-wide)');
    const agentIdx = out.indexOf("# Agent's task or question");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeLessThan(agentIdx);
    expect(out).toContain('Address user formally. Prefer TypeScript.');
  });

  it('omits the memory section entirely when null', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('# Mo memory');
  });
});

describe('buildSynthesizerInput — Mo summary', () => {
  it('appends summary line after the body block when set', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ metadataSummary: 'Mo says this is a deployment task' }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('Mo summary: Mo says this is a deployment task');
  });

  it('omits the summary line when null', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ metadataSummary: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('Mo summary:');
  });

  it('does not render Mo summary in question-mode', () => {
    const out = buildSynthesizerInput({
      input: questionInput,
      bootstrap: mkBootstrap({
        taskId: null,
        metadataSummary: 'should not appear',
      }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('Mo summary');
    expect(out).not.toContain('should not appear');
  });
});

describe('buildSynthesizerInput — body truncation', () => {
  it('truncates task body at 2000 chars with ellipsis', () => {
    const longBody = 'x'.repeat(2500);
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ taskBody: longBody }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('x'.repeat(2000) + '…');
    expect(out).not.toContain('x'.repeat(2001));
  });

  it('substitutes empty string for null taskBody', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ taskBody: null }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    // Body header still emitted; the following line is the empty
    // body content (truncate('', 2000) → '') — no characters from
    // the previous body value leak through.
    expect(out).toContain('body:\n');
    expect(out).not.toContain('task body content');
  });
});

describe('buildSynthesizerInput — recent comments', () => {
  it('renders comment block with count + first 5 entries', () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({
      actor: `user${i}`,
      body: `comment ${i}`,
      createdAt: i,
    }));
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ comments }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('# Recent comments on the task (8)');
    expect(out).toContain('- user0: comment 0');
    expect(out).toContain('- user4: comment 4');
    expect(out).not.toContain('- user5:');
    expect(out).not.toContain('- user7:');
  });

  it('truncates long comment bodies at 300 chars', () => {
    const long = 'a'.repeat(400);
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({
        comments: [{ actor: 'u', body: long, createdAt: 1 }],
      }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('a'.repeat(300) + '…');
  });

  it('omits the comments block when none', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({ comments: [] }),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('# Recent comments');
  });
});

describe('buildSynthesizerInput — Wave 1 sections', () => {
  it('emits keywords block when present', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1({ keywords: ['deploy', 'release', 'macos'] }),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('# Keywords distilled from the task / question');
    expect(out).toContain('deploy, release, macos');
  });

  it('omits keywords block when empty', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1({ keywords: [] }),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('# Keywords');
  });

  it('emits cluster-analyst findings with why + drill list', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1({
        clusterFindings: [
          {
            clusterId: 'cl-A',
            drillIntoNoteIds: ['01N1', '01N2'],
            why: 'core release notes',
          },
        ],
      }),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('# Cluster-analyst findings (Wave 1)');
    expect(out).toContain('- cluster `cl-A`: core release notes');
    expect(out).toContain('  picked notes: 01N1, 01N2');
  });

  it('omits drill-list line when no notes picked', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1({
        clusterFindings: [
          { clusterId: 'cl-X', drillIntoNoteIds: [], why: 'nothing relevant' },
        ],
      }),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).toContain('- cluster `cl-X`: nothing relevant');
    expect(out).not.toContain('  picked notes:');
  });

  it('omits the Wave 1 findings block when empty', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1({ clusterFindings: [] }),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('# Cluster-analyst findings');
  });
});

describe('buildSynthesizerInput — Wave 2 sections', () => {
  it('emits body extractions with id + title + why + chunks', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2({
        bodyExtractions: [
          {
            noteId: '01N1',
            title: 'README',
            chunks: ['npm install', 'npm run build'],
            why: 'shows the build pipeline',
            isWarning: false,
          },
        ],
      }),
      workspaceMemory: null,
    });
    expect(out).toContain('# Body extractions (Wave 2)');
    expect(out).toContain('## [01N1] README');
    expect(out).toContain('why: shows the build pipeline');
    expect(out).toContain('> npm install');
    expect(out).toContain('> npm run build');
  });

  it('marks warning extractions with the ⚠ glyph', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2({
        bodyExtractions: [
          {
            noteId: '01N9',
            title: 'breaks-on-windows',
            chunks: ['fails on win10'],
            why: 'platform-specific gotcha',
            isWarning: true,
          },
        ],
      }),
      workspaceMemory: null,
    });
    expect(out).toContain('## [01N9] breaks-on-windows ⚠ WARNING');
  });

  it('renders workspace candidates with folder + summary', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2({
        workspaceCandidates: [
          {
            noteId: '01CAND1',
            title: 'old release notes',
            summary: 'macOS shipping check-list from v1.2',
            folderId: '01F2',
          },
          {
            noteId: '01CAND2',
            title: 'orphan note',
            summary: null,
            folderId: null,
          },
        ],
      }),
      workspaceMemory: null,
    });
    expect(out).toContain('# Workspace search candidates (not drilled into)');
    expect(out).toContain(
      '- [01CAND1] old release notes (folder: 01F2) — macOS shipping check-list from v1.2',
    );
    expect(out).toContain('- [01CAND2] orphan note (folder: unfiled)');
    // No summary on cand2 → no trailing em-dash chunk
    expect(out).not.toMatch(/orphan note \(folder: unfiled\) — /);
  });

  it('truncates workspace candidate summaries at 200 chars', () => {
    const longSummary = 'b'.repeat(400);
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2({
        workspaceCandidates: [
          {
            noteId: '01CL',
            title: 'long',
            summary: longSummary,
            folderId: '01F',
          },
        ],
      }),
      workspaceMemory: null,
    });
    expect(out).toContain('b'.repeat(200) + '…');
    expect(out).not.toContain('b'.repeat(201));
  });

  it('omits both Wave 2 blocks when empty', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap(),
      wave1: mkWave1(),
      wave2: mkWave2(),
      workspaceMemory: null,
    });
    expect(out).not.toContain('# Body extractions');
    expect(out).not.toContain('# Workspace search candidates');
  });
});

describe('buildSynthesizerInput — section ordering invariant', () => {
  it('renders sections in fixed order: memory → agent → comments → keywords → wave1 → wave2 body → wave2 candidates', () => {
    const out = buildSynthesizerInput({
      input: taskInput,
      bootstrap: mkBootstrap({
        comments: [{ actor: 'u', body: 'c1', createdAt: 1 }],
      }),
      wave1: mkWave1({
        keywords: ['kw'],
        clusterFindings: [
          { clusterId: 'cl', drillIntoNoteIds: ['n'], why: 'w' },
        ],
      }),
      wave2: mkWave2({
        bodyExtractions: [
          {
            noteId: 'n',
            title: 't',
            chunks: ['c'],
            why: 'why',
            isWarning: false,
          },
        ],
        workspaceCandidates: [
          { noteId: 'wc', title: 'wct', summary: null, folderId: null },
        ],
      }),
      workspaceMemory: 'mem',
    });
    const order = [
      '# Mo memory (workspace-wide)',
      "# Agent's task or question",
      '# Recent comments on the task',
      '# Keywords distilled from the task / question',
      '# Cluster-analyst findings (Wave 1)',
      '# Body extractions (Wave 2)',
      '# Workspace search candidates (not drilled into)',
    ];
    const indices = order.map((h) => out.indexOf(h));
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
      }
    }
  });
});
