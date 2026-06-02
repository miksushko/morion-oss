/**
 * Regression: clicking the "MCP server: online" pill in the sidebar
 * footer was a silent no-op. It called `onSelectView('settings')`,
 * but `AppView` no longer includes `'settings'` (it was removed when
 * the unified Settings popup epic 01KPGWTJCWVBQCCSQ8NGSB19KQ replaced
 * the route with a dialog). `tsconfig.json` excludes `src/web`, so
 * the bad string literal was never type-checked.
 *
 * Fix wires the pill to `onOpenMcpSettings`, which the App passes as
 * `() => setSettingsDialog({ tab: 'mcp-server' })`. This test pins
 * three things:
 *   1. AppView still does NOT include 'settings' (so the old wiring
 *      stays broken — guards against accidental re-add of a dead
 *      route).
 *   2. The sidebar source calls onOpenMcpSettings, not
 *      onSelectView('settings'), from the footer pill click.
 *   3. App.tsx still passes onOpenMcpSettings to the Sidebar with
 *      a setSettingsDialog body opening the mcp-server tab.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..');

describe('Sidebar MCP-server footer pill opens Settings (01KRWSM9HET3T3MQTMB7AXRDXY follow-up)', () => {
  it("AppView does not include 'settings' — route was deleted in unified-Settings epic", () => {
    const src = readFileSync(join(REPO, 'src/web/src/appShellTypes.ts'), 'utf8');
    const m = src.match(/export type AppView\s*=\s*([^;]+);/);
    expect(m, 'AppView type def').toBeTruthy();
    expect(m![1]).not.toMatch(/'settings'/);
  });

  it('Sidebar footer pill wires to onOpenMcpSettings, not onSelectView(settings)', () => {
    const src = readFileSync(join(REPO, 'src/web/src/layout/Sidebar.tsx'), 'utf8');
    expect(src).not.toMatch(/onSelectView\(\s*['"]settings['"]\s*\)/);
    expect(src).toMatch(/onOpenMcpSettings\?:\s*\(\)\s*=>\s*void/);
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*onOpenMcpSettings\?\.\(\)\}/);
  });

  it('App.tsx wires onOpenMcpSettings to setSettingsDialog mcp-server tab', () => {
    const src = readFileSync(join(REPO, 'src/web/src/App.tsx'), 'utf8');
    expect(src).toMatch(
      /onOpenMcpSettings=\{\(\)\s*=>\s*setSettingsDialog\(\{\s*tab:\s*['"]mcp-server['"]\s*\}\)\}/,
    );
  });
});
