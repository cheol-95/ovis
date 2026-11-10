import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { VISUALIZATION_PAGE_BYTES, type VisualizationReference } from "../../shared/visualization.ts";
import { fileFailure, fileFailureText, type FileFailure } from "../lib/fileFailure.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useResourceUrlState } from "../lib/useResourceUrl.ts";
import { getTransport } from "../lib/transport.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { useT } from "../lib/i18n.ts";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import "./Visualization.css";

/**
 * The previews the person asked for on this page, by PC and file. A reference alone looks nothing up and runs
 * nothing: the page's script runs in this browser, so it waits for **Show preview**, as a file waits to be opened in
 * the file viewer. Once asked for, a row drawn again (scrolled back to) shows its preview without another press; a
 * reload asks again.
 */
const asked = new Set<string>();

/**
 * Why no preview is drawn: how the file's read failed (lib/fileFailure.ts), a file past the preview's size (`large`)
 * or past what a relay carries to this device (`phone`), or a path that is no HTML page (`page`).
 */
type Missing = FileFailure | "large" | "phone" | "page";
/** the failures another try may get past: the rest (not signed in, a watching device, no such file, too large) offer no Retry */
const RETRYABLE: ReadonlySet<Missing> = new Set<Missing>(["offline", "slow", "server", "limited", "unreadable"]);

/**
 * The status of the frame's own request for `src`, from the browser's record of it: told for the app's own address
 * by browsers that keep it (`responseStatus`), null where there is no record or no status in it.
 */
function pageStatus(src: string): number | null {
  try {
    const entry = performance.getEntriesByName(new URL(src, window.location.href).href).at(-1) as PerformanceResourceTiming | undefined;
    const status = entry?.responseStatus;
    return typeof status === "number" && status > 0 ? status : null;
  } catch { return null; }
}

/** Show the original HTML through FileViewer's Page renderer, without styling or host shims, once the person asks for it. */
export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const machine = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const consent = `${machine}\0${path}`;
  const [shown, setShown] = useState(() => asked.has(consent));
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{ key: string; url: string | null; missing?: Missing } | null>(null);
  const key = `${machine}:${path}:${retry}`;
  const label = title ?? path.split(/[\\/]/).pop() ?? path;
  const relay = getTransport().kind === "relay";
  /** the file's page address, with its revision: a changed file is another address, and so another frame */
  const pageUrl = useCallback(async (): Promise<{ url: string | null; missing?: Missing }> => {
    const info = await fetchFileInfo(path, null);
    if ("candidates" in info || info.mime !== "text/html") return { url: null, missing: "page" };
    if (info.size > VISUALIZATION_PAGE_BYTES) return { url: null, missing: "large" };
    return { url: `${fileUrl(info.path, null)}&render=1&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` };
  }, [path, fetchFileInfo, fileUrl]);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    pageUrl().then((page) => { if (live) setFile({ key, ...page }); }, (reason: unknown) => { if (live) setFile({ key, url: null, missing: fileFailure(reason) }); });
    return () => { live = false; };
  }, [shown, key, pageUrl]);
  const url = shown && file?.key === key ? file.url : null;
  const resource = useResourceUrlState(relay ? null : url, retry);
  const current = useRef(key);
  current.current = key;
  /**
   * The frame reads the page by itself, and cannot say that the read failed after the lookup answered (the file
   * deleted or rewritten, the PC gone): it would only draw the server's refusal. The browser's own record of that
   * request tells its status where the browser keeps one (`pageStatus`, and the observer below for a record that
   * comes after the load): a refusal there is looked into, and a browser with no such record looks the file up
   * again once the frame has loaded. A lookup that fails says why; one that answers after a refused read is the
   * PC's read that failed.
   */
  const verify = useCallback((refused: boolean): void => {
    const at = current.current;
    pageUrl().then((page) => {
      if (current.current !== at) return;
      if (page.url === null) setFile({ key: at, ...page });
      else if (refused) setFile({ key: at, url: null, missing: "server" });
    }, (reason: unknown) => { if (current.current === at) setFile({ key: at, url: null, missing: fileFailure(reason) }); });
  }, [pageUrl]);
  const src = relay ? null : resource.url;
  useEffect(() => {
    if (src === null || typeof PerformanceObserver !== "function") return;
    let observer: PerformanceObserver | undefined;
    try {
      const address = new URL(src, window.location.href).href;
      observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName(address).some((entry) => ((entry as PerformanceResourceTiming).responseStatus ?? 0) >= 400)) verify(true);
      });
      observer.observe({ type: "resource" });
    } catch { observer = undefined; /* a browser that keeps no such record: the lookup after the load stands alone */ }
    return () => observer?.disconnect();
  }, [src, verify]);
  // (the frame is not lazy: it exists only once asked for, and a lazy frame's request is recorded with no status)
  const loaded = (): void => {
    if (src === null) return;
    const status = pageStatus(src);
    // read and answered: nothing to look into
    if (status !== null && status < 400) return;
    verify(status !== null);
  };
  const resourceMissing: Missing | null = resource.error === null ? null : fileFailure(resource.error);
  const missing: Missing | null = shown && file?.key === key && file.url === null ? file.missing ?? "unreadable" : resourceMissing;
  const show = (): void => { asked.add(consent); setShown(true); };
  return <div className="markdown-visualization">
    <div className="markdown-visualization-header">
      {open ? <button type="button" className="markdown-file" title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button> : <span>{label}</span>}
      {open && <button type="button" className="icon-button" aria-label={t("Open {path}", { path })} onClick={() => open(path)}><Maximize2 aria-hidden="true" /></button>}
    </div>
    {!shown ? <div className="markdown-visualization-note">
      <button type="button" className="btn btn-ghost" onClick={show}>{t("Show preview")}</button>
    </div> : missing !== null ? <div className="markdown-visualization-note" role="alert">
      <span>{missing === "large" ? t("Too large to preview here. Open the file to see it.")
        : missing === "phone" ? t("Too large to open on the phone - download on the PC")
          : missing === "page" ? t("The file could not be opened.") : fileFailureText(missing, t)}</span>
      {RETRYABLE.has(missing) && <button type="button" className="btn btn-ghost" onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button>}
    </div> : url === null || (!relay && src === null)
      ? <span className="markdown-visualization-note" role="status">{t("Opening…")}</span>
      : <div className="markdown-visualization-body">
        {relay ? <RelayRenderedPage key={key} path={url} title={label} keep
          onError={(error) => setFile({ key, url: null, missing: error instanceof RelayResourceTooLargeError ? "phone" : fileFailure(error) })} />
          : <iframe key={url} className="markdown-visualization-frame" src={src!} title={label} sandbox="allow-scripts" onLoad={loaded} />}
      </div>}
  </div>;
}

/** Tests start each case with nothing asked for. */
export function forgetShownVisualizations(): void { asked.clear(); }
