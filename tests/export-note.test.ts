import { describe, it, expect } from 'vitest';
import { __test } from '../src/web/src/lib/exportNote';

const { sanitizeFilename } = __test;

describe('sanitizeFilename', () => {
  it('passes through normal titles', () => {
    expect(sanitizeFilename('Hello World')).toBe('Hello World');
  });

  it('falls back to "untitled" on empty / whitespace', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('\t\n')).toBe('untitled');
  });

  it('replaces filesystem-reserved chars with spaces', () => {
    expect(sanitizeFilename('foo/bar:baz')).toBe('foo bar baz');
    expect(sanitizeFilename('a*b?c"d<e>f|g\\h')).toBe('a b c d e f g h');
  });

  it('strips control chars', () => {
    expect(sanitizeFilename('hello\x00world\x1f')).toBe('helloworld');
  });

  it('collapses internal whitespace', () => {
    expect(sanitizeFilename('foo   bar')).toBe('foo bar');
  });

  it('strips trailing dots (Windows quirk)', () => {
    expect(sanitizeFilename('test...')).toBe('test');
    expect(sanitizeFilename('test.txt.')).toBe('test.txt');
  });

  it('truncates to 200 chars', () => {
    const long = 'a'.repeat(500);
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('preserves unicode letters', () => {
    expect(sanitizeFilename('Привет мир')).toBe('Привет мир');
    expect(sanitizeFilename('日本語')).toBe('日本語');
  });

  it('handles markdown-rich titles', () => {
    expect(sanitizeFilename('# My Note: Part 1/2')).toBe('# My Note Part 1 2');
  });
});
