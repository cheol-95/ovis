import { useContext, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useResourceUrlState } from "../lib/useResourceUrl.ts";
import { getTransport } from "../lib/transport.ts";
import { useT } from "../lib/i18n.ts";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import "./Visualization.css";

/** Read only the app's theme, never cookies, session state or other content into an untrusted frame. */
const themeTokens: Record<string, string> = {
  background: "bg", foreground: "text", card: "bg-panel", "card-foreground": "text",
  popover: "bg-elevated", "popover-foreground": "text", muted: "bg-hover", "muted-foreground": "text-dim",
  primary: "primary", "primary-foreground": "primary-text", secondary: "bg-panel", "secondary-foreground": "text",
  accent: "bg-hover", "accent-foreground": "text", border: "border", input: "border-strong", ring: "accent",
  destructive: "status-blocked", blue: "status-working", orange: "accent", green: "status-done",
  red: "status-blocked", purple: "indicator-working", yellow: "notice",
  "viz-series-1": "accent", "viz-series-2": "status-working", "viz-series-3": "status-done",
  "viz-series-4": "status-blocked", "viz-series-5": "indicator-working", "viz-series-6": "text-dim",
};

/** A Codex fragment is a local file, shown through the same sandbox as FileViewer's Page mode. */
export function Visualization({ path, title, wide }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const machine = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{ key: string; url: string | null } | null>(null);
  const [height, setHeight] = useState(360);
  const [ready, setReady] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const key = `${machine}:${path}:${retry}`;
  const label = title ?? path.split(/[\\/]/).pop() ?? path;
  const relay = getTransport().kind === "relay";
  useEffect(() => {
    let live = true;
    setReady(false);
    setPreviewFailed(false);
    setHeight(360);
    fetchFileInfo(path, null).then((info) => {
      const valid = !("candidates" in info) && info.mime === "text/html" && info.size <= 1_048_576;
      if (live) setFile({ key, url: valid ? `${fileUrl(info.path, null)}&render=1&visualize=1&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` : null });
    }, () => { if (live) setFile({ key, url: null }); });
    return () => { live = false; };
  }, [path, key, fetchFileInfo, fileUrl]);
  const url = file?.key === key ? file.url : null;
  const resource = useResourceUrlState(relay ? null : url, retry);
  const failed = previewFailed || (file?.key === key && file.url === null) || resource.error !== null;
  useEffect(() => {
    if (url === null || ready || failed) return;
    const timer = window.setTimeout(() => setPreviewFailed(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [url, ready, failed]);
  useEffect(() => {
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      const values = Object.fromEntries(Object.entries(themeTokens).map(([to, from]) => [`--${to}`, style.getPropertyValue(`--${from}`).trim()]).filter(([, value]) => value !== ""));
      frame.current?.contentWindow?.postMessage({ type: "ovis-visualization-theme", values }, "*");
    };
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      if (event.data?.type === "ovis-visualization-ready") { setReady(true); setPreviewFailed(false); theme(); }
      if (event.data?.type === "ovis-visualization-size" && typeof event.data.height === "number" && Number.isFinite(event.data.height)) {
        setHeight(Math.max(160, Math.min(1600, Math.ceil(event.data.height))));
      }
    };
    window.addEventListener("message", receive);
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "style", "class"] });
    return () => { observer.disconnect(); window.removeEventListener("message", receive); };
  }, [key]);
  return <div className={`markdown-visualization${wide ? " is-wide" : ""}`}>
    <div className="markdown-visualization-header">
      {open ? <button type="button" className="markdown-file" title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button> : <span>{label}</span>}
      {open && <button type="button" className="icon-button" aria-label={t("Open {path}", { path })} onClick={() => open(path)}><Maximize2 aria-hidden="true" /></button>}
    </div>
    {failed ? <div className="markdown-visualization-note" role="alert">
      <span>{t("The file could not be opened.")}</span>
      <button type="button" className="btn btn-ghost" onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button>
    </div> : <>
      {!ready && <span className="markdown-visualization-note" role="status">{t("Opening…")}</span>}
      {url !== null && <div className="markdown-visualization-body" style={{ height }}>
        {relay ? <RelayRenderedPage key={url} path={url} title={label} className="markdown-visualization-frame" frameRef={frame} />
          : resource.url !== null && <iframe key={url} ref={frame} className="markdown-visualization-frame" src={resource.url} title={label} sandbox="allow-scripts" loading="lazy" />}
      </div>}
    </>}
  </div>;
}
