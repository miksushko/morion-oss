/**
 * Contract pin for the Monaco language-inference helper extracted
 * from `src/web/src/components/ConflictResolverModal.tsx` on
 * 2026-05-16. Per Morion ticket 01KRQS8PFFZ7WDM0JRB6FZCADE.
 */
import { describe, expect, it } from 'vitest';

import {
  EXT_TO_LANG,
  inferLanguage,
} from '../src/web/src/components/conflict-resolver/language.js';

describe('inferLanguage', () => {
  it('returns "plaintext" for paths with no extension', () => {
    expect(inferLanguage('LICENSE')).toBe('plaintext');
    expect(inferLanguage('Makefile')).toBe('plaintext');
    expect(inferLanguage('')).toBe('plaintext');
  });

  it('returns "plaintext" for unknown extensions', () => {
    expect(inferLanguage('foo.unknownext')).toBe('plaintext');
    expect(inferLanguage('image.heic')).toBe('plaintext');
  });

  it('case-folds the extension before lookup', () => {
    expect(inferLanguage('SCRIPT.TS')).toBe('typescript');
    expect(inferLanguage('Photo.MD')).toBe('markdown');
  });

  it('uses the LAST `.` so multi-dot filenames pick the real extension', () => {
    expect(inferLanguage('component.spec.tsx')).toBe('typescript');
    expect(inferLanguage('config.test.json')).toBe('json');
  });

  it('maps every entry in EXT_TO_LANG correctly', () => {
    for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
      expect(inferLanguage(`file.${ext}`)).toBe(lang);
    }
  });

  it('covers the families auto-code most often touches', () => {
    expect(inferLanguage('src/main.ts')).toBe('typescript');
    expect(inferLanguage('src/component.tsx')).toBe('typescript');
    expect(inferLanguage('scripts/run.sh')).toBe('shell');
    expect(inferLanguage('Cargo.toml')).toBe('ini');
    expect(inferLanguage('app/views/page.html')).toBe('html');
    expect(inferLanguage('main.py')).toBe('python');
  });
});
