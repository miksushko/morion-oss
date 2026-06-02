import TurndownService from 'turndown';
// @ts-expect-error — @joplin/turndown-plugin-gfm has no bundled types.
// The shape we use (`gfm` plugin function) is documented in the upstream
// README and stable across the package's 1.x line.
import { gfm } from '@joplin/turndown-plugin-gfm';

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndownService) return turndownService;
  turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    // Apple Notes wraps every paragraph in <div>; turndown's default
    // adds an extra newline per div. Use 'one' for tighter output.
    blankReplacement: (_content, node) => {
      // Preserve <br> and intentional blank divs.
      const el = node as HTMLElement;
      return el.nodeName === 'BR' ? '\n' : '';
    },
  });
  // Apple Notes' bodies often have <object data="..."> for non-image
  // attachments — strip those entirely (we don't import them in v1).
  turndownService.remove(['object', 'embed']);
  // GFM plugin adds rules for <table>, <strikethrough>, <task lists>.
  // Without it, turndown silently flattens an Apple Notes table into a
  // run-on text blob — verified empirically. With it, tables import as
  // proper GFM markdown that round-trips through the Tiptap editor.
  turndownService.use(gfm);
  return turndownService;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return getTurndown().turndown(html);
}
