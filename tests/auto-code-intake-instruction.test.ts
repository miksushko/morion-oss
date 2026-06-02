import { describe, it, expect, beforeEach } from 'vitest';

import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  FOLDER_INTAKE_INSTRUCTION_MAX_LEN,
  folderIntakeInstructionKey,
  readFolderIntakeInstruction,
  writeFolderIntakeInstruction,
} from '../src/server/features/auto-code-template-settings.js';

/**
 * Per-folder intake-instruction override — read/write helpers +
 * length cap. The override flows into the workflow runner via
 * `auto-code-factory.ts:resolveFolderWorkflow` (rewrites `mo_start.instruction`
 * on the resolved definition); this suite pins the storage layer
 * contract so a typo in the setting key doesn't silently miss the
 * override.
 */

interface Setup {
  handle: DbHandle;
  settings: SettingsRepository;
}

function setup(): Setup {
  const handle = openDb({ path: ':memory:' });
  const settings = new SettingsRepository(handle.db);
  return { handle, settings };
}

describe('per-folder intake instruction setting', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it('reads empty string when nothing is stored', () => {
    expect(readFolderIntakeInstruction(s.settings, 'fld_test')).toBe('');
  });

  it('round-trips a non-empty value', () => {
    writeFolderIntakeInstruction(
      s.settings,
      'fld_test',
      'Accept any ticket with content; reject only empty ones.',
    );
    expect(readFolderIntakeInstruction(s.settings, 'fld_test')).toBe(
      'Accept any ticket with content; reject only empty ones.',
    );
  });

  it('trims whitespace on read AND write', () => {
    writeFolderIntakeInstruction(
      s.settings,
      'fld_test',
      '  \n  reject under-specified tickets  \n  ',
    );
    expect(readFolderIntakeInstruction(s.settings, 'fld_test')).toBe(
      'reject under-specified tickets',
    );
  });

  it('returns empty on a non-string stored value (defensive)', () => {
    s.settings.set(folderIntakeInstructionKey('fld_test'), 42);
    expect(readFolderIntakeInstruction(s.settings, 'fld_test')).toBe('');
  });

  it('refuses values longer than the cap with a clear error', () => {
    const too_long = 'x'.repeat(FOLDER_INTAKE_INSTRUCTION_MAX_LEN + 1);
    expect(() =>
      writeFolderIntakeInstruction(s.settings, 'fld_test', too_long),
    ).toThrow(/intake instruction too long/);
  });

  it('scopes per-folder — folder A override does not leak to folder B', () => {
    writeFolderIntakeInstruction(s.settings, 'fld_a', 'rule A');
    writeFolderIntakeInstruction(s.settings, 'fld_b', 'rule B');
    expect(readFolderIntakeInstruction(s.settings, 'fld_a')).toBe('rule A');
    expect(readFolderIntakeInstruction(s.settings, 'fld_b')).toBe('rule B');
    expect(readFolderIntakeInstruction(s.settings, 'fld_other')).toBe('');
  });

  it('clears the override by writing an empty string', () => {
    writeFolderIntakeInstruction(s.settings, 'fld_test', 'something');
    writeFolderIntakeInstruction(s.settings, 'fld_test', '');
    expect(readFolderIntakeInstruction(s.settings, 'fld_test')).toBe('');
  });
});
