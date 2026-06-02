import { fileTypeFromBuffer } from 'file-type';
import { ALLOWED_MIME_TYPES, type AllowedMime } from './types.js';

/**
 * Magic-byte sniffing. The Content-Type header sent by a browser is
 * informational — we decide the MIME from the first bytes of the file.
 * Defence against a client claiming `image/png` while uploading
 * `<svg><script>…</script></svg>` or a binary that isn't an image at
 * all. `file-type` v19 is pure ESM, no native deps, recognizes every
 * allowed format via magic bytes.
 *
 * Returns the detected MIME if it's in the allow-list, or null if the
 * file isn't a recognized image or is of a banned type (e.g. SVG —
 * file-type will detect it as `image/svg+xml`, which is not in the
 * allow-list).
 */
export async function sniffAllowedMime(buffer: Buffer): Promise<AllowedMime | null> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) return null;
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(detected.mime)
    ? (detected.mime as AllowedMime)
    : null;
}

/**
 * Map MIME to the canonical file extension we'll name files with. The
 * client's original filename is never used on disk — we control both
 * the id (ulid) and the extension (from MIME), so path-traversal is
 * structurally impossible.
 */
export function extensionForMime(mime: AllowedMime): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
  }
}

/**
 * Best-effort image dimension probe for the formats we accept. Reads only
 * the file header bytes — no full decode. Used at upload time to populate
 * `attachments.width` / `.height` so Phase 4's `notes_list_attachments`
 * MCP tool can return dimensions without re-reading the file.
 *
 * Returns `{ width, height }` on success, or `{ width: null, height: null }`
 * if the header shape isn't one we know how to parse. Extending the probe
 * to cover more edge cases is cheap; failing open is safe because the
 * dimensions are metadata-only and not load-bearing.
 *
 * Format-specific offsets:
 *   - PNG: bytes 16-20 = width (BE uint32), 20-24 = height (BE uint32),
 *     after the 8-byte signature + 4-byte length + 4-byte IHDR marker.
 *   - GIF: bytes 6-8 = width (LE uint16), 8-10 = height (LE uint16),
 *     after the 6-byte GIF87a/GIF89a signature.
 *   - JPEG: scan for SOF0/SOF2 marker, then height (BE uint16) + width
 *     (BE uint16). Slightly more code but still header-only.
 *   - WebP: VP8/VP8L/VP8X chunks after "RIFF....WEBP" header; width
 *     + height packed per subformat.
 */
export function probeImageDimensions(
  buffer: Buffer,
  mime: AllowedMime,
): { width: number | null; height: number | null } {
  try {
    switch (mime) {
      case 'image/png':
        return probePng(buffer);
      case 'image/gif':
        return probeGif(buffer);
      case 'image/jpeg':
        return probeJpeg(buffer);
      case 'image/webp':
        return probeWebp(buffer);
    }
  } catch {
    // Any parse failure → null. Dimensions are non-critical metadata.
    return { width: null, height: null };
  }
}

function probePng(buf: Buffer): { width: number | null; height: number | null } {
  // PNG signature is 8 bytes; IHDR chunk starts at offset 8 with a
  // 4-byte length + "IHDR" marker. Width + height are at 16..24.
  if (buf.length < 24) return { width: null, height: null };
  if (buf.slice(12, 16).toString('ascii') !== 'IHDR') {
    return { width: null, height: null };
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function probeGif(buf: Buffer): { width: number | null; height: number | null } {
  if (buf.length < 10) return { width: null, height: null };
  return {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
  };
}

function probeJpeg(buf: Buffer): { width: number | null; height: number | null } {
  // Walk the JPEG marker stream looking for SOF0 / SOF1 / SOF2 (progressive).
  // Start after the initial SOI (0xFFD8). Each segment is
  // 0xFF <marker> <length-2-byte-BE> <payload>.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { width: null, height: null };
  }
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return { width: null, height: null };
    const marker = buf[offset + 1];
    // SOF markers: 0xC0 (baseline), 0xC1 (extended), 0xC2 (progressive).
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // Layout after marker: 2 bytes segment length, 1 byte precision,
      // 2 bytes height (BE), 2 bytes width (BE).
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segLen = buf.readUInt16BE(offset + 2);
    offset += 2 + segLen;
  }
  return { width: null, height: null };
}

function probeWebp(buf: Buffer): { width: number | null; height: number | null } {
  // RIFF container: "RIFF" (4) + length (4) + "WEBP" (4) + chunk type (4).
  if (buf.length < 30) return { width: null, height: null };
  if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return { width: null, height: null };
  if (buf.slice(8, 12).toString('ascii') !== 'WEBP') return { width: null, height: null };
  const chunkType = buf.slice(12, 16).toString('ascii');
  if (chunkType === 'VP8 ') {
    // Simple lossy. Width + height at 26 + 28 (both LE uint16 masked 14-bit).
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (chunkType === 'VP8L') {
    // Lossless. After 5-byte signature (0x2f), 2 bytes hold (width-1)
    // & 0x3FFF with height-1 in next 14 bits.
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (chunkType === 'VP8X') {
    // Extended. Canvas dimensions at bytes 24..30, each as 3 bytes LE,
    // stored as (dim-1).
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { width: w, height: h };
  }
  return { width: null, height: null };
}
