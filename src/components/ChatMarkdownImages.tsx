import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useMachineApi } from "../lib/machineContext.tsx";
import { markdownImagePreview } from "../lib/markdownImages.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MarkdownImageContext, MarkdownImageOpenContext, MarkdownImageRetryContext } from "./Markdown.tsx";

/** Resolve on the pane's PC; the viewer stays with ChatView when an image's row scrolls away. */
export function ChatMarkdownImages({ paneId, cwd, connected, onOpen, children }: {
  paneId: string; cwd: string | null; connected: boolean; onOpen: (image: GalleryImage) => void; children: ReactNode;
}) {
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const connection = useRef(connected);
  const [reconnect, setReconnect] = useState(0);
  useEffect(() => {
    const before = connection.current;
    connection.current = connected;
    if (connected && !before) setReconnect((epoch) => epoch + 1);
  }, [connected]);
  const resolve = useCallback((src: string) => markdownImagePreview(
    // A virtual document places relative references in cwd; absolute ones need no cwd.
    src, cwd?.startsWith("/") ? `${cwd.replace(/\/$/, "")}/.ovis-chat.md` : "",
    (path) => fetchFileInfo(path, paneId), (path, download) => fileUrl(path, paneId, download),
  ), [cwd, paneId, fetchFileInfo, fileUrl]);
  return <MarkdownImageContext.Provider value={resolve}>
    <MarkdownImageRetryContext.Provider value={reconnect}>
      <MarkdownImageOpenContext.Provider value={onOpen}>{children}</MarkdownImageOpenContext.Provider>
    </MarkdownImageRetryContext.Provider>
  </MarkdownImageContext.Provider>;
}
