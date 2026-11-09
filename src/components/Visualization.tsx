import { useContext, useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useResourceUrlState } from "../lib/useResourceUrl.ts";
import { getTransport } from "../lib/transport.ts";
import { useT } from "../lib/i18n.ts";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import "./Visualization.css";

/** Show the original HTML through FileViewer's Page renderer, without styling or host shims. */
export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const machine = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${machine}:${path}:${retry}`;
  const label = title ?? path.split(/[\\/]/).pop() ?? path;
  const relay = getTransport().kind === "relay";
  useEffect(() => {
    let live = true;
    fetchFileInfo(path, null).then((info) => {
      const valid = !("candidates" in info) && info.mime === "text/html" && info.size <= 1_048_576;
      if (live) setFile({ key, url: valid ? `${fileUrl(info.path, null)}&render=1&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` : null });
    }, () => { if (live) setFile({ key, url: null }); });
    return () => { live = false; };
  }, [path, key, fetchFileInfo, fileUrl]);
  const url = file?.key === key ? file.url : null;
  const resource = useResourceUrlState(relay ? null : url, retry);
  const failed = (file?.key === key && file.url === null) || resource.error !== null;
  return <div className="markdown-visualization">
    <div className="markdown-visualization-header">
      {open ? <button type="button" className="markdown-file" title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button> : <span>{label}</span>}
      {open && <button type="button" className="icon-button" aria-label={t("Open {path}", { path })} onClick={() => open(path)}><Maximize2 aria-hidden="true" /></button>}
    </div>
    {failed ? <div className="markdown-visualization-note" role="alert">
      <span>{t("The file could not be opened.")}</span>
      <button type="button" className="btn btn-ghost" onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button>
    </div> : url === null || (!relay && resource.url === null)
      ? <span className="markdown-visualization-note" role="status">{t("Opening…")}</span>
      : <div className="markdown-visualization-body">
        {relay ? <RelayRenderedPage key={url} path={url} title={label} />
          : <iframe key={url} className="markdown-visualization-frame" src={resource.url!} title={label} sandbox="allow-scripts" loading="lazy" />}
      </div>}
  </div>;
}
