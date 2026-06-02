import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { ImageOff } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Custom Tiptap node view for images.
 *
 * Two src shapes:
 *   - `morion://attachment/<id>` — our own attachment. Browser `<img>`
 *     can't send the X-Morion-Token auth header, so we fetch the bytes
 *     as a Blob via the auth'd API wrapper, turn it into an object URL,
 *     and hand that to `<img src>`. CSP already allows `blob:`; no
 *     CSP edit needed.
 *   - Anything else (http, https, data:) — straight pass-through. The
 *     external image loads through the browser's normal img pipeline;
 *     https is in `img-src` on the CSP allowlist.
 *
 * Upload-in-progress state: when `handlePaste` / `handleDrop` inserts
 * an image before the sidecar has returned an id, it sets
 * `attrs.uploading = true` and uses a temporary `blob:` URL as src.
 * That URL passes through the "anything else" branch so the user sees
 * the image immediately. Once the upload resolves the extension swaps
 * `src` to the permanent `morion://` URL and clears the uploading
 * attr.
 *
 * Cleanup: object URLs are revoked on unmount so a long editing
 * session doesn't pin blob storage indefinitely.
 */
export function MorionImageNodeView(props: NodeViewProps) {
  const src = (props.node.attrs.src as string) ?? '';
  const alt = (props.node.attrs.alt as string) ?? '';
  const uploading = Boolean(props.node.attrs.uploading);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const currentSrcRef = useRef<string>('');

  useEffect(() => {
    if (!src.startsWith('morion://attachment/')) {
      // External / blob / data URL — leave to the browser. Revoke any
      // stale blob we created during a previous morion:// render.
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        setObjectUrl(null);
      }
      currentSrcRef.current = '';
      setErrored(false);
      return;
    }

    if (currentSrcRef.current === src && objectUrl) {
      // Already resolved this src — don't re-fetch on re-render.
      return;
    }
    currentSrcRef.current = src;
    const id = src.slice('morion://attachment/'.length);

    let cancelled = false;
    setErrored(false);
    api
      .fetchAttachment(id)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setObjectUrl((prev) => {
          // Swap: revoke the old URL before overwriting so we don't
          // leak blob storage for the previous image.
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[attachment] fetch failed', id, err);
        setErrored(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  // Unmount cleanup — revoke any live blob URL we created.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // objectUrl intentionally left out of the deps list: we want to
    // revoke the LAST value at unmount only, not on every swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decide what to show. Priority:
  //   1. Loading skeleton (uploading OR morion:// not yet resolved).
  //   2. Error tile (fetch failed / wrong id).
  //   3. Rendered <img> (resolved object URL or external src).
  const showSkeleton =
    (uploading && !src.startsWith('http') && !src.startsWith('data:')) ||
    (src.startsWith('morion://attachment/') && !objectUrl && !errored);

  const effectiveSrc = src.startsWith('morion://attachment/') ? objectUrl ?? '' : src;

  return (
    <NodeViewWrapper className="my-2 inline-block max-w-full">
      {errored ? (
        <span
          className="inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
          role="img"
          aria-label={alt || 'image failed to load'}
        >
          <ImageOff className="h-3.5 w-3.5" aria-hidden="true" />
          {alt || 'Image unavailable'}
        </span>
      ) : showSkeleton ? (
        <span
          className="inline-flex h-24 w-40 animate-pulse items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground"
          role="status"
          aria-label={uploading ? 'Uploading image' : 'Loading image'}
        >
          {uploading ? 'Uploading…' : 'Loading…'}
        </span>
      ) : (
        <img
          src={effectiveSrc}
          alt={alt}
          className={cn(
            'max-h-[70vh] max-w-full rounded-md border border-border',
            uploading && 'opacity-60',
          )}
          onError={() => setErrored(true)}
          draggable={false}
        />
      )}
    </NodeViewWrapper>
  );
}
