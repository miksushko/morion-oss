import { describe, expect, it } from 'vitest';

import { renderPromptTemplate } from '../src/core/auto-code/workflows/template.ts';

describe('renderPromptTemplate', () => {
  it('substitutes top-level keys', () => {
    const r = renderPromptTemplate('Hello {{name}}', { name: 'world' });
    expect(r.output).toBe('Hello world');
    expect(r.missingKeys).toEqual([]);
  });

  it('substitutes deep paths', () => {
    const r = renderPromptTemplate('Title={{ticket.title}}', {
      ticket: { title: 'Tetris' },
    });
    expect(r.output).toBe('Title=Tetris');
  });

  it('records missing keys, substitutes empty', () => {
    const r = renderPromptTemplate('{{a}}/{{b.c}}/{{a}}', { a: 'X' });
    expect(r.output).toBe('X//X');
    expect(r.missingKeys).toEqual(['b.c']);
  });

  it('handles whitespace inside placeholder', () => {
    const r = renderPromptTemplate('{{  name  }}', { name: 'spacey' });
    expect(r.output).toBe('spacey');
  });

  it('serialises objects as JSON', () => {
    const r = renderPromptTemplate('{{stages.fix.output}}', {
      stages: { fix: { output: { v: 1, ok: true } } },
    });
    expect(r.output).toBe('{"v":1,"ok":true}');
  });

  it('formats numbers and booleans', () => {
    const r = renderPromptTemplate('{{n}}/{{b}}', { n: 42, b: false });
    expect(r.output).toBe('42/false');
  });

  it('returns empty for null and undefined', () => {
    const r = renderPromptTemplate('[{{x}}]', { x: null });
    expect(r.output).toBe('[]');
  });

  it('leaves non-matching {{ untouched', () => {
    const r = renderPromptTemplate('not a {{ broken', {});
    expect(r.output).toBe('not a {{ broken');
  });

  it('does not interpret {{a-b}} as path (charset guard)', () => {
    const r = renderPromptTemplate('{{a-b}}', { 'a-b': 'X' });
    expect(r.output).toBe('{{a-b}}');
  });
});
