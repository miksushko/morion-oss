import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/core/import/frontmatter.js';

describe('parseFrontmatter — basic cases', () => {
  it('extracts title from YAML', () => {
    const r = parseFrontmatter('---\ntitle: My Title\n---\nBody here');
    expect(r.title).toBe('My Title');
    expect(r.body).toBe('Body here');
    expect(r.hadFrontmatter).toBe(true);
  });

  it('strips frontmatter block from body', () => {
    const r = parseFrontmatter('---\ntitle: X\ntags: [a, b]\n---\n\n# Heading\n\nText');
    expect(r.body).not.toContain('---');
    expect(r.body).toContain('# Heading');
  });

  it('returns body verbatim when no frontmatter', () => {
    const r = parseFrontmatter('# Heading\n\nText');
    expect(r.body).toBe('# Heading\n\nText');
    expect(r.title).toBeNull();
    expect(r.tags).toEqual([]);
    expect(r.hadFrontmatter).toBe(false);
  });

  it('extracts array-form tags', () => {
    const r = parseFrontmatter('---\ntags: [draft, kanban, urgent]\n---\nText');
    expect(r.tags).toEqual(['draft', 'kanban', 'urgent']);
  });

  it('extracts comma-separated tags', () => {
    const r = parseFrontmatter('---\ntags: "draft, kanban, urgent"\n---\nText');
    expect(r.tags).toEqual(['draft', 'kanban', 'urgent']);
  });

  it('dedupes tags case-insensitively, preserving original casing of first occurrence', () => {
    const r = parseFrontmatter('---\ntags: [Draft, draft, DRAFT]\n---\nText');
    expect(r.tags).toEqual(['Draft']);
  });

  it('parses ISO 8601 created date', () => {
    const r = parseFrontmatter('---\ncreated: 2025-03-15T10:30:00Z\n---\nText');
    expect(r.createdAt).toBe(Date.parse('2025-03-15T10:30:00Z'));
  });

  it('falls back to `date` field when `created` absent', () => {
    const r = parseFrontmatter('---\ndate: 2025-03-15\n---\nText');
    expect(r.createdAt).not.toBeNull();
    expect(r.createdAt).toBe(Date.parse('2025-03-15'));
  });

  it('captures aliases as string list', () => {
    const r = parseFrontmatter('---\naliases: [Foo, Bar]\n---\nText');
    expect(r.aliases).toEqual(['Foo', 'Bar']);
  });
});

describe('parseFrontmatter — edge cases', () => {
  it('handles malformed YAML gracefully (returns body verbatim, no throw)', () => {
    const broken = '---\ntitle: \\\n  invalid: [yaml here\n---\nBody';
    const r = parseFrontmatter(broken);
    expect(r.hadFrontmatter).toBe(false);
    // Body should at least contain "Body" — we don't lose user data.
    expect(r.body).toContain('Body');
  });

  it('treats epoch-seconds number as seconds and converts to ms', () => {
    const r = parseFrontmatter('---\ncreated: 1736942400\n---\nText'); // 2025-01-15
    expect(r.createdAt).toBe(1736942400 * 1000);
  });

  it('keeps epoch-ms number as ms', () => {
    const r = parseFrontmatter('---\ncreated: 1736942400000\n---\nText');
    expect(r.createdAt).toBe(1736942400000);
  });

  it('returns null createdAt for unparseable date', () => {
    const r = parseFrontmatter('---\ncreated: not-a-date\n---\nText');
    expect(r.createdAt).toBeNull();
  });

  it('handles empty frontmatter block', () => {
    const r = parseFrontmatter('---\n---\nText');
    expect(r.title).toBeNull();
    expect(r.tags).toEqual([]);
    expect(r.body).toBe('Text');
  });

  it('preserves body whitespace beyond first non-blank', () => {
    const r = parseFrontmatter('---\ntitle: X\n---\n\n\n  indented\nline');
    expect(r.body).toContain('  indented');
  });
});
