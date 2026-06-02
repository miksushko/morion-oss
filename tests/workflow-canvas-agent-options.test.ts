import { describe, it, expect } from 'vitest';
import {
  providerOptionsFor,
  canonicalProviderFor,
  levelOptionsFor,
  modelPlaceholderFor,
  levelFootnoteFor,
  KIND_LABELS,
  KIND_STYLES,
  AGENT_OPTIONS,
} from '../src/web/src/components/canvas/agent-options';

describe('canvas/agent-options — provider matrix', () => {
  it('claude is anthropic-only', () => {
    expect(canonicalProviderFor('claude')).toBe('anthropic');
    expect(providerOptionsFor('claude')).toEqual(['anthropic']);
  });

  it('codex is openai-only', () => {
    expect(canonicalProviderFor('codex')).toBe('openai');
    expect(providerOptionsFor('codex')).toEqual(['openai']);
  });

  it('pi spans openrouter/groq/ollama plus closed-vendor providers', () => {
    expect(canonicalProviderFor('pi')).toBe('openrouter');
    expect(providerOptionsFor('pi')).toContain('openrouter');
    expect(providerOptionsFor('pi')).toContain('groq');
    expect(providerOptionsFor('pi')).toContain('ollama');
  });

  it('opencode lists openrouter first (canonical)', () => {
    expect(canonicalProviderFor('opencode')).toBe('openrouter');
    expect(providerOptionsFor('opencode')[0]).toBe('openrouter');
  });

  it('AGENT_OPTIONS covers exactly the four CLI tools', () => {
    expect(AGENT_OPTIONS).toEqual(['claude', 'codex', 'pi', 'opencode']);
  });
});

describe('canvas/agent-options — level enums', () => {
  it('claude has the 5-tier Think ladder', () => {
    expect(levelOptionsFor('claude')).toEqual([
      'Default',
      'Think',
      'ThinkHard',
      'ThinkHarder',
      'Ultrathink',
    ]);
  });

  it('codex has the 4-tier reasoning effort scale', () => {
    expect(levelOptionsFor('codex')).toEqual(['Default', 'Low', 'Medium', 'High']);
  });

  it('pi/opencode collapse to Default-only (no native level knob)', () => {
    expect(levelOptionsFor('pi')).toEqual(['Default']);
    expect(levelOptionsFor('opencode')).toEqual(['Default']);
  });

  it('falls back to Default-only for null / undefined / unknown agents', () => {
    expect(levelOptionsFor(null)).toEqual(['Default']);
    expect(levelOptionsFor(undefined)).toEqual(['Default']);
    expect(levelOptionsFor('antigravity')).toEqual(['Default']);
  });
});

describe('canvas/agent-options — model placeholders', () => {
  it('claude placeholder references claude-opus / claude-sonnet examples', () => {
    expect(modelPlaceholderFor('claude')).toMatch(/claude/);
  });

  it('codex placeholder references gpt / o4 examples', () => {
    expect(modelPlaceholderFor('codex')).toMatch(/gpt|o4/);
  });

  it('pi placeholder mentions Ollama + OpenRouter routing', () => {
    expect(modelPlaceholderFor('pi')).toMatch(/Ollama/);
    expect(modelPlaceholderFor('pi')).toMatch(/OpenRouter/);
  });

  it('unknown agent gets a generic placeholder', () => {
    expect(modelPlaceholderFor('antigravity')).toMatch(/vendor-native/);
  });
});

describe('canvas/agent-options — level footnotes', () => {
  it('claude footnote describes the inlined-prompt idiom', () => {
    expect(levelFootnoteFor('claude')).toMatch(/think/i);
  });

  it('codex footnote names the env-flag gate', () => {
    expect(levelFootnoteFor('codex')).toMatch(/MORION_CODEX_REASONING_EFFORT/);
  });

  it('pi/opencode have no footnote (single option)', () => {
    expect(levelFootnoteFor('pi')).toBeNull();
    expect(levelFootnoteFor('opencode')).toBeNull();
  });
});

describe('canvas/agent-options — kind labels + styles', () => {
  it('every CanvasStage kind has both a label and a tailwind style row', () => {
    const kinds = [
      'cli_agent',
      'mcp_tool_call',
      'human_gate',
      'branch',
      'mo_router',
      'eject',
      'mo_stage',
      'reject_sink',
      'complete_sink',
    ] as const;
    for (const k of kinds) {
      expect(KIND_LABELS[k]).toBeTruthy();
      expect(KIND_STYLES[k]).toBeTruthy();
    }
  });

  it('deprecated kinds advertise their status in the label', () => {
    expect(KIND_LABELS.mo_router).toMatch(/deprecated/);
    expect(KIND_LABELS.eject).toMatch(/deprecated/);
  });
});
