import { useEffect, useRef, useState } from "react";
import { getTransport } from "../lib/transport.ts";
import { relayResourceBlob, RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Pages kept for a caller that asked (`keep`), by their address, which names the file's revision: a chat row that
 * scrolls away and back is drawn again, and would otherwise download its whole page over the relay again. A few
 * pages at most, none past KEPT_PAGE_CHARS; the oldest goes first.
 */
const KEPT_PAGES = 4, KEPT_PAGE_CHARS = 8 * 1024 * 1024;
const kept = new Map<string, string>();
function keepPage(path: string, html: string): void {
  if (html.length > KEPT_PAGE_CHARS) return;
  kept.delete(path);
  kept.set(path, html);
  while (kept.size > KEPT_PAGES) kept.delete(kept.keys().next().value!);
}
/** Tests start each case with no page kept. */
export function forgetKeptPages(): void { kept.clear(); }

/**
 * The render host has pagePolicy(null), not the shell policy that a srcdoc would inherit.
 * `onError`: the caller shows the failure itself (a chat preview offers Retry), and nothing is drawn here for it.
 * `keep`: the page's text is kept for the next time this address is drawn (above).
 */
export function RelayRenderedPage({ path, title, onError, keep = false }: { path: string; title: string; onError?: (error: unknown) => void; keep?: boolean }) {
  const t = useT();
  const [loaded, setLoaded] = useState<{ path: string; html: string } | null>(() => { const html = keep ? kept.get(path) : undefined; return html === undefined ? null : { path, html }; });
  const [error, setError] = useState<unknown>(null);
  const sent = useRef(false);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    sent.current = false;
    const had = keep ? kept.get(path) : undefined;
    if (had !== undefined) { setLoaded({ path, html: had }); return; }
    setLoaded(null);
    void getTransport().fetch(path, { signal: abort.signal })
      .then(relayResourceBlob).then((blob) => blob.text()).then((html) => {
        if (abort.signal.aborted) return;
        if (keep) keepPage(path, html);
        setLoaded({ path, html });
      }).catch((error: unknown) => { if (!abort.signal.aborted) { setError(error); failed.current?.(error); } });
    return () => abort.abort();
  }, [path, keep]);
  if (error && onError) return null;
  if (error) return <p className="file-viewer-note" role="alert">{error instanceof RelayResourceTooLargeError
    ? t("Too large to open on the phone - download on the PC")
    : t("The file could not be opened.")}</p>;
  if (loaded?.path !== path) return null;
  return <iframe key={path} className="file-viewer-page" src={`${window.location.pathname}~render`} sandbox="allow-scripts" title={title}
    onLoad={(event) => {
      if (sent.current) return;
      sent.current = true;
      event.currentTarget.contentWindow?.postMessage({ type: "ovis-render", html: loaded.html }, "*");
    }} />;
}
