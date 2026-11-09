/** Owned, synthetic visualization fixture: no user session or files are read. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/components/Markdown.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { OpenFileContext } from "../src/lib/filePaths.ts";
import "../src/styles.css";
import "../src/components/ChatView.css";

declare global { interface Window { visualizationQa: { update: (value: string) => void; opened: string[] } } }
function Fixture() {
  const [text, setText] = useState("Loading fixture");
  const [opened] = useState<string[]>([]);
  window.visualizationQa = { update: setText, opened };
  return <SettingsProvider><MachineContext.Provider value="fixture-pc"><OpenFileContext.Provider value={(path) => { opened.push(path); }}>
    <main style={{ maxWidth: 960, margin: "auto", padding: 16 }}><Markdown>{text}</Markdown></main>
  </OpenFileContext.Provider></MachineContext.Provider></SettingsProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
