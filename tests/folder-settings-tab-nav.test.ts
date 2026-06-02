import { describe, expect, it } from 'vitest';
import {
  FOLDER_TAB_SPECS,
  type FolderSettingsTab,
} from '../src/web/src/components/folder-settings/FolderTabNav';

describe('FOLDER_TAB_SPECS', () => {
  it('keeps the canonical six-tab order', () => {
    // 'workflows' was promoted out of the Auto-code tab into its own
    // tab under the Automation section — ticket
    // 01KRYB4RV660RREP8XHNPT651B. It sits directly after 'auto-code'
    // and inherits the same group label (omitted on the spec since
    // the FolderTabButton only renders the group header on the first
    // member of each group).
    expect(FOLDER_TAB_SPECS.map((s) => s.key)).toEqual([
      'general',
      'access',
      'summary',
      'topics',
      'auto-code',
      'workflows',
    ] satisfies FolderSettingsTab[]);
  });

  it('gates only Mo-dependent tabs by AI access', () => {
    const gated = FOLDER_TAB_SPECS.filter((s) => s.gatedByAccess === true).map(
      (s) => s.key,
    );
    expect(gated).toEqual(['summary', 'topics']);
  });

  it('opens group headers at the right positions', () => {
    const groupByKey = Object.fromEntries(
      FOLDER_TAB_SPECS.map((s) => [s.key, s.group ?? null]),
    );
    expect(groupByKey).toEqual({
      general: 'Folder',
      access: null,
      summary: 'Folder Memory',
      topics: null,
      'auto-code': 'Automation',
      // 'workflows' inherits the Automation group label from
      // 'auto-code' above — no own header to avoid a duplicate
      // "AUTOMATION" line.
      workflows: null,
    });
  });
});
