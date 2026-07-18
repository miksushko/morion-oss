// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { resolveInstaller, latestJsonSchema } from '../src/web/src/components/UpdateBanner';

/**
 * Regression for the v1.5.2 auto-update 404. The macOS notarization leg
 * failed, so finalize published a latest.json carrying ONLY win32-x64. A
 * macOS client (`darwin-arm64`) then found no matching platform entry and
 * the old resolveInstaller FABRICATED a legacy DMG URL
 * (`Morion_1.5.2_aarch64.dmg`) that didn't exist -> "download failed: HTTP
 * 404" instead of the graceful "open the releases page" fallback every
 * other platform gets.
 *
 * Contract now: fabricate the legacy DMG URL ONLY for a truly legacy
 * release (no `platforms` map at all). If `platforms` is present but lacks
 * the client's platform, return null.
 */
const V = '1.5.2';
const DMG_URL = `https://github.com/miksushko/morion-releases/releases/download/v${V}/Morion_${V}_aarch64.dmg`;
const WIN_URL = `https://github.com/miksushko/morion-releases/releases/download/v${V}/Morion_${V}_x64-setup.exe`;
const SHA = 'a'.repeat(64);

function parse(json: unknown) {
  const r = latestJsonSchema.safeParse(json);
  if (!r.success) throw new Error('fixture failed schema: ' + r.error.message);
  return r.data;
}

describe('resolveInstaller', () => {
  it('uses the platforms entry when present (modern release)', () => {
    const p = parse({ version: V, platforms: { 'darwin-arm64': { url: DMG_URL, sha256: SHA }, 'win32-x64': { url: WIN_URL } } });
    expect(resolveInstaller(p, 'darwin-arm64')).toEqual({ url: DMG_URL, sha256: SHA });
    expect(resolveInstaller(p, 'win32-x64')).toEqual({ url: WIN_URL, sha256: null });
  });

  it('PARTIAL publish: platforms present but darwin missing -> null (graceful), NOT a guessed DMG url', () => {
    // This is the exact v1.5.2 incident shape: win32-only manifest.
    const p = parse({ version: V, platforms: { 'win32-x64': { url: WIN_URL, sha256: SHA } } });
    expect(resolveInstaller(p, 'darwin-arm64')).toBeNull();
  });

  it('empty platforms map -> null for every platform', () => {
    const p = parse({ version: V, platforms: {} });
    expect(resolveInstaller(p, 'darwin-arm64')).toBeNull();
    expect(resolveInstaller(p, 'win32-x64')).toBeNull();
  });

  it('legacy flat schema (no platforms map) still fabricates the darwin DMG url', () => {
    const p = parse({ version: V, dmg_sha256: SHA });
    expect(resolveInstaller(p, 'darwin-arm64')).toEqual({ url: DMG_URL, sha256: SHA });
  });

  it('legacy flat schema returns null for non-darwin platforms', () => {
    const p = parse({ version: V, dmg_sha256: SHA });
    expect(resolveInstaller(p, 'win32-x64')).toBeNull();
    expect(resolveInstaller(p, 'linux-x64')).toBeNull();
  });
});
