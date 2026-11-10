import { useContext, useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { VISUALIZATION_PAGE_BYTES, type VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useResourceUrlState } from "../lib/useResourceUrl.ts";
import { getTransport } from "../lib/transport.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { useT } from "../lib/i18n.ts";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import "./Visualization.css";

/**
 * Why no preview is drawn. `failed` may work on another try, so it offers Retry; a file past the preview's size
 * (`large`) or past what a relay carries to this device (`phone`) never will, and opens in the file viewer.
 */
type Missing = "failed" | "large" | "phone";

/** Show the original HTML through FileViewer's Page renderer, without styling or host shims. */
export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const machine = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{ key: string; url: string | null; missing?: Missing } | null>(null);
  // a relay page is read by RelayRenderedPage itself: its failure is told here, so it gets the same note and Retry
  const [relayMissing, setRelayMissing] = useState<{ key: string; missing: Missing } | null>(null);
  const key = `${machine}:${path}:${retry}`;
  const label = title ?? path.split(/[\\/]/).pop() ?? path;
  const relay = getTransport().kind === "relay";
  useEffect(() => {
    let live = true;
    fetchFileInfo(path, null).then((info) => {
      if (!live) return;
      const page = !("candidates" in info) && info.mime === "text/html" ? info : null;
      if (page !== null && page.size > VISUALIZATION_PAGE_BYTES) setFile({ key, url: null, missing: "large" });
      else setFile({ key, url: page !== null ? `${fileUrl(page.path, null)}&render=1&revision=${encodeURIComponent(`${page.modified}:${page.size}`)}` : null });
    }, () => { if (live) setFile({ key, url: null }); });
    return () => { live = false; };
  }, [path, key, fetchFileInfo, fileUrl]);
  const url = file?.key === key ? file.url : null;
  const resource = useResourceUrlState(relay ? null : url, retry);
  const missing: Missing | null = file?.key === key && file.url === null ? file.missing ?? "failed"
    : relayMissing?.key === key ? relayMissing.missing : resource.error !== null ? "failed" : null;
  return <div className="markdown-visualization">
    <div className="markdown-visualization-header">
      {open ? <button type="button" className="markdown-file" title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button> : <span>{label}</span>}
      {open && <button type="button" className="icon-button" aria-label={t("Open {path}", { path })} onClick={() => open(path)}><Maximize2 aria-hidden="true" /></button>}
    </div>
    {missing !== null ? <div className="markdown-visualization-note" role="alert">
      <span>{missing === "large" ? t("Too large to preview here. Open the file to see it.")
        : missing === "phone" ? t("Too large to open on the phone - download on the PC") : t("The file could not be opened.")}</span>
      {missing === "failed" && <button type="button" className="btn btn-ghost" onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button>}
    </div> : url === null || (!relay && resource.url === null)
      ? <span className="markdown-visualization-note" role="status">{t("Opening…")}</span>
      : <div className="markdown-visualization-body">
        {relay ? <RelayRenderedPage key={key} path={url} title={label}
          onError={(error) => setRelayMissing({ key, missing: error instanceof RelayResourceTooLargeError ? "phone" : "failed" })} />
          : <iframe key={url} className="markdown-visualization-frame" src={resource.url!} title={label} sandbox="allow-scripts" loading="lazy" />}
      </div>}
  </div>;
}
