import mammoth from 'mammoth';
import TurndownService from 'turndown';
// @ts-expect-error — @joplin/turndown-plugin-gfm has no bundled types.
import { gfm } from '@joplin/turndown-plugin-gfm';

/**
 * .docx → markdown converter (Phase 4).
 *
 * Wraps mammoth.js. Returns the converted markdown plus an array of
 * inline image attachments extracted during conversion. The image
 * placeholder URLs in the returned markdown use a synthetic
 * `data-mammoth-image:<index>` scheme so the engine layer can swap
 * them for `morion://attachment/<id>` once the bytes are written
 * to the attachment store.
 *
 * Hard contract (per Phase 4 ticket): import only text + standard
 * formatting + images. Footnotes / comments / headers / footers /
 * shapes / OLE / TOC / cross-refs are all stripped — either by
 * mammoth's defaults or by post-processing.
 */

const SIZE_CAP_BYTES = 20 * 1024 * 1024; // 20 MB

export interface DocxConversionResult {
  markdown: string;
  /** Inline images extracted during conversion. The engine writes
   *  the bytes to disk + creates an attachment row, then rewrites
   *  the placeholder in `markdown` with the morion:// URL. */
  images: Array<{
    /** Order-preserving index used in the placeholder
     *  (`data-mammoth-image:<index>`). */
    index: number;
    /** MIME type as sniffed by mammoth from the embedded media. */
    mimeType: string;
    /** Image bytes. */
    bytes: Buffer;
  }>;
  /** Mammoth's per-message warnings (style-not-mapped, image-too-big,
   *  etc.) — surfaced in the import summary. */
  warnings: string[];
}

export class DocxTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxTooLargeError';
  }
}

export class DocxLegacyDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxLegacyDocError';
  }
}

export class DocxPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxPasswordError';
  }
}

/**
 * Convert a .docx Buffer to markdown.
 *
 * Throws:
 *   - `DocxLegacyDocError` if the buffer is the old binary `.doc`
 *     format (mammoth doesn't support it; we detect via magic bytes).
 *   - `DocxTooLargeError` if input exceeds 20 MB.
 *   - `DocxPasswordError` if mammoth fails to read with a password-
 *     protected error.
 *   - Generic `Error` for other read failures.
 */
export async function convertDocxToMarkdown(
  bytes: Buffer,
): Promise<DocxConversionResult> {
  if (bytes.length > SIZE_CAP_BYTES) {
    throw new DocxTooLargeError(
      `Document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, larger than the ${SIZE_CAP_BYTES / 1024 / 1024} MB cap. Split it into smaller files first.`,
    );
  }

  // Magic-byte check: .docx is a ZIP (PK\x03\x04 / PK\x05\x06 /
  // PK\x07\x08 signatures); legacy .doc starts with the OLE compound
  // signature D0 CF 11 E0 A1 B1 1A E1.
  if (bytes.length >= 8) {
    const oleHeader = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    if (bytes.slice(0, 8).equals(oleHeader)) {
      throw new DocxLegacyDocError(
        'Old .doc binary format not supported. Open the file in Word and "Save As .docx" first.',
      );
    }
    const zipHeader = bytes.slice(0, 2).toString();
    if (zipHeader !== 'PK') {
      throw new Error(
        'File does not look like a .docx (missing ZIP signature).',
      );
    }
  }

  // Collect inline images during the conversion. Mammoth's
  // `imageConverter` callback fires per embedded image; we keep the
  // bytes + assign a stable index, return a placeholder src that
  // the engine swaps for the morion:// URL after disk write +
  // attachment row.
  const images: DocxConversionResult['images'] = [];
  let nextIndex = 0;

  // mammoth's `images.imgElement` accepts a function returning an
  // object with `src` + optional alt. We exploit it to siphon bytes
  // into our `images` array and return a unique placeholder src.
  const imageConverter = mammoth.images.imgElement(async (image) => {
    const idx = nextIndex++;
    const buffer = await image.read();
    const bytesBuf = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer as ArrayBuffer);
    images.push({
      index: idx,
      mimeType: image.contentType ?? 'application/octet-stream',
      bytes: bytesBuf,
    });
    return { src: `data-mammoth-image:${idx}` };
  });

  // Mammoth options:
  //   - `convertImage`: our siphon
  //   - default style map keeps Heading 1-6, list, paragraph
  //     mappings; we don't ADD custom mappings.
  let result: { value: string; messages: Array<{ message: string; type?: string }> };
  try {
    result = await mammoth.convertToHtml(
      { buffer: bytes },
      { convertImage: imageConverter },
    );
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (
      msg.toLowerCase().includes('password') ||
      msg.toLowerCase().includes('encrypt')
    ) {
      throw new DocxPasswordError(
        'Document is password-protected; remove the password in Word and re-export.',
      );
    }
    throw new Error(`Failed to read .docx: ${msg}`);
  }

  // Convert HTML → markdown via turndown (already in deps from
  // Phase 3 / Apple Notes). We use convertToHtml + turndown rather
  // than mammoth.convertToMarkdown directly because (a) the .d.ts
  // doesn't expose convertToMarkdown (typed-runtime mismatch with
  // mammoth.js), (b) sharing one HTML→md converter across docx +
  // Apple Notes keeps post-processing rules consistent.
  const turndown = getTurndown();
  let markdown = turndown.turndown(result.value);

  // Post-process to strip artefacts mammoth doesn't filter on its own.
  // The Phase 4 contract is "no footnotes / endnotes" — mammoth
  // injects them as numbered superscripts followed by the footnote
  // content at the end. Strip the trailing footnote section + the
  // inline `^[<sup>1</sup>]` superscripts.
  markdown = stripFootnoteArtefacts(markdown);
  markdown = stripStrayHtmlAttrs(markdown);

  // Mammoth emits "Unrecognised X style: 'Foo' (Style ID: Bar)" for
  // every custom Word style it can't map (Scene Break, custom heading
  // variants, internal review marks, etc.). The Phase 4 contract is
  // explicit — custom styles fall back to plain text by design. Those
  // warnings aren't actionable for the user and bloat the import
  // summary's "errored" counter, making a clean import look broken.
  // Drop them; keep everything else (image-decode failures, real
  // parse errors, etc. ARE actionable).
  const meaningfulWarnings = result.messages
    .map((m) => m.message)
    .filter(
      (msg) =>
        !msg.startsWith('Unrecognised paragraph style') &&
        !msg.startsWith('Unrecognised run style') &&
        !msg.startsWith('Unrecognised character style') &&
        !msg.startsWith('Unrecognised note reference style'),
    );

  return {
    markdown,
    images,
    warnings: meaningfulWarnings,
  };
}

let turndownInstance: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  turndownInstance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  // Strip docx-emitted artefact tags that survive HTML conversion
  // — we explicitly don't want them in the body.
  turndownInstance.remove(['object', 'embed', 'style', 'script']);
  // GFM plugin adds rules for <table>, <strikethrough>, <task lists>.
  // Without it, Word's tables flatten into a run-on text blob — same
  // regression class as Apple Notes import. Required for the Tiptap
  // table feature to round-trip docx imports cleanly.
  turndownInstance.use(gfm);
  return turndownInstance;
}

/**
 * Mammoth emits footnotes as a trailing list after a horizontal
 * rule, plus inline superscript markers like `[1]`. We strip both
 * because the Phase 4 contract is "no footnotes". Implemented as
 * regex post-processing rather than a mammoth transform because
 * mammoth's transform API requires a deeper understanding of its
 * AST shape than we want to take on.
 */
function stripFootnoteArtefacts(md: string): string {
  // Trailing footnote section: mammoth puts it after a `---` rule
  // with footnote-id-style anchors `[1]:` or numbered list items.
  // Conservative: only strip if we see the canonical footnote
  // marker pattern (`\n\\[\\d+\\]\\s+` lines).
  let out = md;
  const trailingFootnoteSection = /\n+(?:\[\d+\]\s+.*(?:\n|$))+/;
  out = out.replace(trailingFootnoteSection, '');

  // Inline superscript markers — mammoth's default markdown emits
  // `[1]` style with no link target after we strip the trailing
  // section. Drop them.
  out = out.replace(/\[\d+\](?!\()/g, '');

  return out;
}

/**
 * Mammoth occasionally leaves `id="..."` / `class="..."` attrs on
 * inline HTML elements it can't fully demote. They're inert in
 * Tiptap (html: false) but ugly in the markdown. Strip them.
 */
function stripStrayHtmlAttrs(md: string): string {
  return md.replace(/\s+(?:id|class|name|data-[a-z-]+)="[^"]*"/g, '');
}

/** Test-only re-export. */
export const __test = {
  stripFootnoteArtefacts,
  stripStrayHtmlAttrs,
  SIZE_CAP_BYTES,
};
