import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Ed25519 public key for the Morion release-signing chain (C2,
 * 2026-04-17). Corresponds to the private key `MORION_RELEASE_PRIVATE_KEY`
 * held as a GitHub Actions secret and used by `.github/workflows/publish.yml`
 * to sign `latest.json` on every release.
 *
 * If this key ever needs to rotate:
 *   1. Generate new keypair via `openssl genpkey -algorithm Ed25519 ...`
 *   2. Replace this constant AND the GitHub secret in one release.
 *   3. Old installs running older Morion will refuse to update because
 *      the new `latest.json.sig` is signed by the new key. They must
 *      manually download the new DMG from
 *      https://github.com/miksushko/morion-releases — document this
 *      in the release notes.
 *
 * Embedding the public key in source (not a build-time env var) is
 * intentional: the whole point of the signature is that an attacker
 * who compromises the GitHub PAT can't publish a DMG our clients
 * accept. If the pubkey could be swapped at build time, the same PAT
 * compromise compromises this defence.
 */
const MORION_RELEASE_PUBKEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAogtYGXuzYr6B56Dn/XOwd/EXBtZ1vNtKCUjiWb24SYM=',
  '-----END PUBLIC KEY-----',
].join('\n');

// Parse once at module load so every /api/updates/latest request
// doesn't re-parse the PEM.
const PUBLIC_KEY = createPublicKey({
  key: MORION_RELEASE_PUBKEY_PEM,
  format: 'pem',
});

/**
 * Verify an Ed25519 signature over `payload` using the Morion release
 * public key. Returns true on match, false on anything else
 * (wrong signature, malformed signature, payload mutation).
 *
 * Node's `crypto.verify(null, ...)` is the idiomatic Ed25519 call —
 * the first arg (algorithm) is `null` because Ed25519 hashes the
 * message internally with SHA-512. Matches what
 * `openssl pkeyutl -sign -rawin` produces in CI.
 *
 * Signatures are always 64 bytes. We accept Buffer or Uint8Array for
 * both `payload` and `signature` to cover the fetch-response case
 * (ArrayBuffer-backed Uint8Array) and the read-from-disk case.
 */
export function verifyReleaseSignature(
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return cryptoVerify(null, payload, PUBLIC_KEY, signature);
  } catch {
    // Malformed signature (wrong length, non-canonical encoding) throws
    // synchronously in some Node versions. Treat that as "invalid".
    return false;
  }
}

/** Exposed for tests that need to inject an alternative key. Not used
 * in production — verifyReleaseSignature is the stable API. */
export const _MORION_RELEASE_PUBKEY_PEM = MORION_RELEASE_PUBKEY_PEM;
