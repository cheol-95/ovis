import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

type Shown = { path: string; as: "popup" | "page" | "docked" };
declare global { interface Window { outlineQA: { open: (path: string, as?: Shown["as"]) => void } } }

/** The real viewer in its three presentations: the popup, a reader page, and docked beside a pane. */
function Fixture() {
  const [shown, setShown] = useState<Shown | null>(null);
  window.outlineQA = { open: (path, as = "popup") => setShown({ path, as }) };
  if (shown === null) return <main><button type="button">Outside</button></main>;
  const close = () => setShown(null);
  if (shown.as === "page") return <div className="file-reader-frame" style={{ height: "100vh" }}><FileViewer key={shown.path} page path={shown.path} paneId={null} onClose={close} /></div>;
  if (shown.as === "docked") return <div style={{ display: "flex", height: "100vh" }}>
    <main style={{ flex: "1 1 auto" }}><button type="button">Outside</button></main>
    <FileViewer key={shown.path} docked path={shown.path} paneId={null} onClose={close} />
  </div>;
  return <main><button type="button">Outside</button><FileViewer key={shown.path} path={shown.path} paneId={null} onClose={close} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
