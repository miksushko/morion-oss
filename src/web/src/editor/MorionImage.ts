import { Image } from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ulid } from 'ulid';
import type { EditorView } from '@tiptap/pm/view';
import { api } from '../lib/api';
import { MorionImageNodeView } from './MorionImageNodeView';

/**
 * Morion's Tiptap Image extension.
 *
 * Extends the stock `@tiptap/extension-image` so tiptap-markdown keeps
 * serializing `<img>` nodes to `![alt](src)` verbatim — nothing special
 * to do at the markdown boundary. We override:
 *
 *   - `addNodeView` → mount our React NodeView that resolves
 *     `morion://attachment/<id>` URLs via auth'd blob fetch. See
 *     `MorionImageNodeView.tsx` for the rendering logic.
 *
 *   - `addAttributes` → declare an `uploading` attr used for the
 *     transient placeholder state while the sidecar is still writing
 *     the file to disk.
 *
 *   - `addProseMirrorPlugins` → a `handlePaste` / `handleDrop` plugin
 *     that intercepts image Files from the clipboard / drag, inserts
 *     an uploading placeholder with a `blob:` src, and swaps the node
 *     to the permanent `morion://` src once the upload resolves.
 *
 * The `noteId` option threads the current note's id through from
 * `TiptapEditor.tsx`. Without it the upload has no owner — uploads fire
 * but the server returns 404 because `noteId` isn't in the query string.
 * `configure({ noteId })` is called once per editor mount, updated via
 * `editor.extensionManager.extensions` on note switch.
 */

interface UploadState {
  /** Temporary id threaded through the placeholder's data attr so we
   * can find the right node in the doc tree when the upload resolves. */
  uploadId: string;
  /** `blob:` URL we created for the placeholder — revoked once the
   * node is swapped to the permanent morion:// URL. */
  blobUrl: string;
  /** Abort controller for the fetch in case the editor unmounts or the
   * note switches mid-upload. */
  controller: AbortController;
}

/**
 * Plugin key for the per-editor upload registry. State is map-keyed by
 * uploadId so multiple in-flight uploads (user pasted three
 * screenshots in a row) don't step on each other.
 */
const MORION_UPLOAD_PLUGIN_KEY = new PluginKey<Map<string, UploadState>>(
  'morion-image-upload',
);

export interface MorionImageOptions {
  /**
   * Function returning the current note id. Pulled via a getter rather
   * than a plain string because Tiptap options are frozen at mount
   * time and we want paste / drop to honour the latest selected note
   * without remounting the editor.
   */
  getNoteId: () => string | null;
  /** Getter for the upload-error callback. Same freshness rationale
   * as `getNoteId`. */
  getOnUploadError: () => ((message: string) => void) | undefined;
}

export const MorionImage = Image.extend<MorionImageOptions>({
  name: 'image',

  addOptions() {
    return {
      ...this.parent?.(),
      getNoteId: () => null,
      getOnUploadError: () => undefined,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      uploading: {
        default: false,
        // Don't serialize — it's transient UI state, not part of the
        // markdown / HTML contract. `![alt](url)` never carries an
        // "uploading" flag and restoring from DB never starts in that
        // state either.
        rendered: false,
      },
      uploadId: {
        default: null,
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MorionImageNodeView);
  },

  addProseMirrorPlugins() {
    const getOptions = (): MorionImageOptions => this.options;

    return [
      new Plugin<Map<string, UploadState>>({
        key: MORION_UPLOAD_PLUGIN_KEY,
        state: {
          init: () => new Map<string, UploadState>(),
          apply: (_tr, value) => value, // registry mutated imperatively
        },
        props: {
          handlePaste(view, event) {
            const files = collectImageFiles(event.clipboardData?.items);
            if (files.length === 0) return false;
            event.preventDefault();
            for (const file of files) void startUpload(view, file, getOptions());
            return true;
          },
          handleDrop(view, event) {
            const files = collectImageFiles(event.dataTransfer?.items);
            if (files.length === 0) return false;
            event.preventDefault();
            for (const file of files) void startUpload(view, file, getOptions());
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * Gather every `File` of type image/* from a DataTransferItemList (used
 * for both clipboard paste and Finder drop). Returns an empty array if
 * nothing image-shaped was present.
 */
function collectImageFiles(items: DataTransferItemList | undefined): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/**
 * Insert an uploading placeholder image at the current selection, then
 * fire the upload. On success swap the node's src/uploading attrs to
 * the permanent values. On failure remove the placeholder node and
 * surface the error via the registered callback.
 */
async function startUpload(
  view: EditorView,
  file: File,
  opts: MorionImageOptions,
): Promise<void> {
  const noteId = opts.getNoteId();
  const onUploadError = opts.getOnUploadError();
  if (!noteId) {
    onUploadError?.('Save the note before adding an image.');
    return;
  }

  const uploadId = ulid();
  const blobUrl = URL.createObjectURL(file);
  const altFromName = file.name.replace(/\.[^.]+$/, '');

  // Insert placeholder.
  const { state, dispatch } = view;
  const imageType = state.schema.nodes.image;
  if (!imageType) return;
  const node = imageType.create({
    src: blobUrl,
    alt: altFromName,
    uploading: true,
    uploadId,
  });
  const tr = state.tr.replaceSelectionWith(node);
  dispatch(tr);

  try {
    const result = await api.uploadAttachment(file, noteId);

    // Find the placeholder node by uploadId and swap its attrs.
    const latestState = view.state;
    let found: { pos: number; node: typeof node } | null = null;
    latestState.doc.descendants((n, pos) => {
      if (n.type.name === 'image' && n.attrs.uploadId === uploadId) {
        found = { pos, node: n };
        return false;
      }
      return true;
    });
    if (found) {
      const anyFound = found as unknown as {
        pos: number;
        node: { attrs: Record<string, unknown> };
      };
      const swapTr = latestState.tr.setNodeMarkup(anyFound.pos, undefined, {
        ...anyFound.node.attrs,
        src: result.url,
        uploading: false,
        uploadId: null,
      });
      view.dispatch(swapTr);
    }
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    // Remove the placeholder so the doc doesn't retain a broken upload.
    const latestState = view.state;
    let removePos: { from: number; to: number } | null = null;
    latestState.doc.descendants((n, pos) => {
      if (n.type.name === 'image' && n.attrs.uploadId === uploadId) {
        removePos = { from: pos, to: pos + n.nodeSize };
        return false;
      }
      return true;
    });
    if (removePos) {
      const { from, to } = removePos as unknown as { from: number; to: number };
      view.dispatch(latestState.tr.delete(from, to));
    }
    URL.revokeObjectURL(blobUrl);
    const message = err instanceof Error ? err.message : 'Upload failed';
    onUploadError?.(message);
  }
}
