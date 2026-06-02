import { useEffect, useRef } from 'react';
import { api } from './api';

/**
 * Post-render hook that finds every `<img data-morion-id="...">` in
 * the container and swaps `src` to an auth'd blob URL (via
 * `api.fetchAttachment(id)` → `URL.createObjectURL(blob)`).
 *
 * Why a hook + imperative DOM swap instead of a React component tree:
 * the comment markdown is rendered via `dangerouslySetInnerHTML` (output
 * of `renderCommentMarkdown`), so we can't mount React components for
 * each image. Walking the DOM after paint is cheap + predictable, and
 * we already own the cleanup (revokeObjectURL on unmount).
 *
 * Dedupe: `data-morion-resolved` is set on success so a re-render
 * (which rebuilds `innerHTML`) doesn't re-fetch already-resolved ids —
 * except when the markdown content changes and the nodes are replaced,
 * in which case new nodes lack the marker.
 *
 * Error handling: on fetch failure, the img gets an `aria-label` + a
 * visible `title` + a `morion-comment-image--error` class so CSS can
 * render a placeholder.
 */
export function useResolveMorionImages(
  containerRef: React.RefObject<HTMLElement>,
  // Re-run whenever the markdown content changes — the consumer passes
  // the body string or a key derived from it. Without this the hook
  // only runs on mount.
  deps: React.DependencyList,
): void {
  // Track every blob URL we create so unmount can revoke them. Using a
  // ref instead of state because we never want a re-render on swap.
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img[data-morion-id]'));
    if (imgs.length === 0) return;

    let cancelled = false;
    const freshUrls: string[] = [];

    for (const img of imgs) {
      if (img.dataset.morionResolved === 'true') continue;
      const id = img.dataset.morionId;
      if (!id) continue;

      // Provisional styling — swap class when resolved/errored.
      img.classList.add('morion-comment-image--pending');

      api
        .fetchAttachment(id)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          freshUrls.push(url);
          img.src = url;
          img.dataset.morionResolved = 'true';
          img.classList.remove('morion-comment-image--pending');
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('[comment image] fetch failed', id, err);
          img.classList.remove('morion-comment-image--pending');
          img.classList.add('morion-comment-image--error');
          img.title = 'Image unavailable';
          img.setAttribute('aria-label', 'Image unavailable');
        });
    }

    // Commit the fresh urls to the persistent ref so the unmount
    // cleanup below can revoke them.
    blobUrlsRef.current = [...blobUrlsRef.current, ...freshUrls];

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Revoke every blob URL we ever created on unmount. Run once on
  // component teardown — individual swaps mutate the ref but we only
  // care about the final set.
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current = [];
    };
  }, []);
}
