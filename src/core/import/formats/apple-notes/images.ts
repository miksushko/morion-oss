/**
 * Apple Notes embeds images inline as `<img src="data:image/...;base64,...">`
 * in the HTML body. Without extraction, turndown carries the entire base64
 * blob into the markdown body — multi-MB notes lock up the editor and
 * unsupported MIME types (TIFF / HEIC) render as alt-text "carousels"
 * because no browser displays them.
 *
 * This pass walks each note's HTML BEFORE turndown:
 *   - PNG / JPEG / GIF / WebP → buffered + replaced with a synthetic
 *     placeholder URL the engine swaps for `morion://attachment/<id>`
 *     post-import. Same `finaliseUploadImages` path docx uses.
 *   - TIFF / HEIC / SVG / unknown → image stripped, replaced with a
 *     short text marker so the user can see something was removed.
 */

const SUPPORTED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const APPLE_NOTES_IMG_PLACEHOLDER_PREFIX = 'data-apple-notes-image:';

const APPLE_NOTES_INLINE_IMG_RE =
  /<img\b[^>]*?\bsrc\s*=\s*["']data:([^;"']+);base64,([^"']+)["'][^>]*?>/gi;

export interface ExtractedAppleNotesImage {
  placeholder: string;
  mimeType: string;
  bytes: Buffer;
}

export interface ExtractInlineImagesResult {
  cleanedHtml: string;
  images: ExtractedAppleNotesImage[];
  /** Count of inline images that were stripped (unsupported MIME or
   *  decode failure). Surfaced as a single per-note warning so the
   *  user knows something was dropped without spamming N errors. */
  strippedCount: number;
}

export function extractInlineImages(
  html: string,
  startCounter: number,
): ExtractInlineImagesResult {
  const images: ExtractedAppleNotesImage[] = [];
  let strippedCount = 0;
  let counter = startCounter;
  const cleanedHtml = html.replace(
    APPLE_NOTES_INLINE_IMG_RE,
    (_match, rawMime: string, rawB64: string) => {
      const mime = rawMime.toLowerCase().trim();
      // Strip data-URI whitespace artefacts (Apple Notes sometimes
      // line-wraps the base64 payload).
      const b64 = rawB64.replace(/\s+/g, '');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(b64, 'base64');
      } catch {
        strippedCount++;
        return '';
      }
      if (!SUPPORTED_IMAGE_MIME.has(mime)) {
        strippedCount++;
        return '';
      }
      const placeholder = `${APPLE_NOTES_IMG_PLACEHOLDER_PREFIX}${counter++}`;
      images.push({ placeholder, mimeType: mime, bytes });
      return `<img src="${placeholder}">`;
    },
  );
  return { cleanedHtml, images, strippedCount };
}
