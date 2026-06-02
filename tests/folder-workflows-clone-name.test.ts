/**
 * Regression: clone naming for the folder-settings Workflows list.
 * Ticket 01KRYBG9N6HMQG308ZTSQSMMND specifies (a) capital-C "(Copy)"
 * on first clone, (b) "(Copy 2)" / "(Copy 3)" / ... on subsequent
 * clones of a row whose name already ends with "(Copy)" — never
 * "(Copy)(Copy)".
 */
import { describe, it, expect } from 'vitest';
import { nextCloneName } from '../src/web/src/components/folder-settings/auto-code/clone-name';

describe('nextCloneName (01KRYBG9N6HMQG308ZTSQSMMND)', () => {
  it('adds " (Copy)" to a plain name', () => {
    expect(nextCloneName('Foo')).toBe('Foo (Copy)');
  });

  it('bumps "(Copy)" to "(Copy 2)"', () => {
    expect(nextCloneName('Foo (Copy)')).toBe('Foo (Copy 2)');
  });

  it('bumps "(Copy 2)" to "(Copy 3)"', () => {
    expect(nextCloneName('Foo (Copy 2)')).toBe('Foo (Copy 3)');
  });

  it('bumps two-digit counters', () => {
    expect(nextCloneName('Foo (Copy 99)')).toBe('Foo (Copy 100)');
  });

  it('tolerates extra whitespace around the marker', () => {
    expect(nextCloneName('Foo  (Copy 2)  ')).toBe('Foo (Copy 3)');
  });

  it('does NOT collide with the lowercase server "(copy)" marker (different shape)', () => {
    // The legacy server-side clone endpoint names the row "(copy)"
    // lowercase. Client-side clone-name logic targets "(Copy)" only,
    // so legacy-named rows get a fresh "(Copy)" suffix appended.
    // Documented behaviour, not a bug.
    expect(nextCloneName('Foo (copy)')).toBe('Foo (copy) (Copy)');
  });

  it('handles names that contain "(Copy)" but not as the suffix', () => {
    expect(nextCloneName('My (Copy) Workflow')).toBe('My (Copy) Workflow (Copy)');
  });

  it('emoji + unicode base name', () => {
    expect(nextCloneName('Морион-флоу (Copy 7)')).toBe('Морион-флоу (Copy 8)');
  });
});
