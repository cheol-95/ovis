import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { forgetShownVisualizations, Visualization } from "./Visualization.tsx";
import { forgetKeptPages } from "./RelayRenderedPage.tsx";
import type { FileInfo } from "../../shared/files.ts";
import { VISUALIZATION_PAGE_BYTES } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { RELAY_BLOB_LIMIT } from "../lib/relay/resources.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator", "PerformanceObserver"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;
/** what the browser's record of a request tells its observers: here, the frames' own page reads */
let recorded: Array<(entries: Array<{ name: string; responseStatus?: number }>) => void> = [];

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  recorded = [];
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, location: { pathname: "/s/shell/", href: "https://ovis.test/s/shell/" }, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, activeElement: null, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
    PerformanceObserver: class {
      private readonly tell: (entries: Array<{ name: string; responseStatus?: number }>) => void;
      constructor(callback: (list: { getEntriesByName: (name: string) => unknown[] }) => void) {
        this.tell = (entries) => callback({ getEntriesByName: (name) => entries.filter((entry) => entry.name === name) });
      }
      observe(): void { recorded.push(this.tell); }
      disconnect(): void { recorded = recorded.filter((each) => each !== this.tell); }
    },
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  setTransport(nativeTransport);
  forgetShownVisualizations();
  forgetKeptPages();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const PATH = "/w/diagram.html";
const html = (size: number, modified = "2026-11-09T00:00:00Z"): FileInfo => ({ path: PATH, name: "diagram.html", size, modified, mime: "text/html", kind: "text" });
const refusal = (status: number, code: string) => () => Response.json({ error: { code, message: code } }, { status });

/**
 * A PC: each stat gets the next of `stats` and each read of the rendered page the next of `pages` (the last one
 * again after that). A stat is a FileInfo, or a refusal.
 */
function pc(kind: Transport["kind"], stats: Array<FileInfo | (() => Response)>, pages: Array<() => Response> = []): { transport: Transport; stats: () => number; reads: () => number } {
  let asked = 0, reads = 0;
  const transport: Transport = {
    ...nativeTransport,
    kind,
    fetch: async (input) => {
      if (String(input).includes("/api/fs/stat")) {
        const stat = stats[Math.min(asked, stats.length - 1)]!;
        asked += 1;
        return typeof stat === "function" ? stat() : Response.json(stat);
      }
      const page = pages[Math.min(reads, pages.length - 1)]!;
      reads += 1;
      return page();
    },
  };
  return { transport, stats: () => asked, reads: () => reads };
}

const shown = (): string => JSON.stringify(renderer?.toJSON());
const frames = (): ReactTestInstance[] => renderer?.root.findAllByType("iframe") ?? [];
const button = (label: string): ReactTestInstance[] => renderer?.root.findAll((node) => node.type === "button" && node.children.includes(label)) ?? [];
const press = async (label: string): Promise<void> => { await act(async () => { (button(label)[0]!.props["onClick"] as () => void)(); }); };

/** Turns pass until `done`: the stat, the page read and the state they set each take some. */
async function until(done: () => boolean): Promise<void> {
  for (let round = 0; round < 500 && !done(); round++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  expect(done()).toBe(true);
}

async function draw(transport: Transport): Promise<void> {
  setTransport(transport);
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, { value: () => {}, children: createElement(Visualization, { path: PATH, wide: false }) }) }));
  });
}
/** a reference drawn, then its preview asked for */
async function show(transport: Transport): Promise<void> {
  await draw(transport);
  await press("Show preview");
}

test("a reference alone looks nothing up and runs nothing; Show preview draws the page, and a row drawn again shows it without another press", async () => {
  // Given a reference in an answer
  const local = pc("native", [html(4096)]);
  await draw(local.transport);
  await until(() => button("Show preview").length === 1);
  // Then the card names the file and offers the preview: no lookup, no frame
  expect(frames()).toHaveLength(0);
  expect(local.stats()).toBe(0);
  expect(renderer?.root.findAll((node) => node.type === "button" && node.props["title"] === `Open ${PATH}`)).toHaveLength(1);

  // When the person asks for it
  await press("Show preview");
  await until(() => frames().length === 1);
  // Then the Page renderer draws the file, with its script, in the sandbox
  expect(frames()[0]!.props["src"]).toContain("render=1");
  expect(frames()[0]!.props["sandbox"]).toBe("allow-scripts");
  expect(local.stats()).toBe(1);

  // When the row scrolls away and is drawn again
  await act(async () => renderer?.unmount());
  await draw(local.transport);
  // Then the preview asked for is shown again by itself
  await until(() => frames().length === 1);
  expect(button("Show preview")).toHaveLength(0);
});

test("an HTML file up to the size the Page renderer keeps whole is previewed; a larger one says so and offers no retry", async () => {
  // Given a visualization of 2 MiB, as one with its pictures written into it is
  await show(pc("native", [html(2 * 1024 * 1024)]).transport);
  await until(() => frames().length === 1);
  await act(async () => renderer?.unmount());

  // Given one exactly at the limit, then one a byte past it
  await draw(pc("native", [html(VISUALIZATION_PAGE_BYTES)]).transport);
  await until(() => frames().length === 1);
  await act(async () => renderer?.unmount());
  const large = pc("native", [html(VISUALIZATION_PAGE_BYTES + 1)]);
  await draw(large.transport);
  await until(() => shown().includes("Too large to preview here. Open the file to see it."));
  // Then the note names the size, nothing is loaded, another try would change nothing, and the file still opens from its title
  expect(frames()).toHaveLength(0);
  expect(button("Retry")).toHaveLength(0);
  expect(shown()).not.toContain("The file could not be opened.");
  expect(renderer?.root.findAll((node) => node.type === "button" && node.props["title"] === `Open ${PATH}`)).toHaveLength(1);
  expect(large.reads()).toBe(0);
});

test("a lookup that fails says why, and offers Retry only where another try can work", async () => {
  // a watching device is refused every file read, a browser that is not paired too, and a path may be no file: no Retry
  for (const [status, code, words] of [[403, "read_only", "The PC denied access to this file."], [401, "unauthorized", "Pair this browser again to open the file."], [404, "not_found", "No readable file at this path."]] as const) {
    await show(pc("native", [refusal(status, code)]).transport);
    await until(() => shown().includes(words));
    expect(button("Retry")).toHaveLength(0);
    await act(async () => renderer?.unmount());
    forgetShownVisualizations();
  }
  // a PC that is away, or whose read failed, may answer the next time: Retry looks the file up again
  const away = pc("native", [refusal(502, "machine_offline"), refusal(500, "internal"), html(4096)]);
  await show(away.transport);
  await until(() => shown().includes("That PC is not reachable right now."));
  await press("Retry");
  await until(() => shown().includes("The PC could not read the file. Reopen it to try again."));
  await press("Retry");
  await until(() => frames().length === 1);
  expect(away.stats()).toBe(3);
});

test("a page read the frame made and the PC refused, or a file gone since its lookup, is told and can be retried", async () => {
  // Given a preview whose lookup answered
  const local = pc("native", [html(4096), html(4096), html(4096), refusal(404, "not_found")]);
  await show(local.transport);
  await until(() => frames().length === 1);
  const src = String(frames()[0]!.props["src"]);
  // When the browser's record of the frame's own request shows the PC refused it (the file was being rewritten)
  await act(async () => { for (const tell of recorded) tell([{ name: new URL(src, "https://ovis.test/s/shell/").href, responseStatus: 500 }]); });
  // Then the preview says the read failed, with Retry, instead of leaving the refusal in the frame
  await until(() => shown().includes("The PC could not read the file. Reopen it to try again."));
  expect(frames()).toHaveLength(0);
  await press("Retry");
  await until(() => frames().length === 1);
  // When the frame has loaded and the file is gone (a browser that keeps no such record learns it from this lookup)
  await act(async () => { (frames()[0]!.props["onLoad"] as () => void)(); });
  await until(() => shown().includes("No readable file at this path."));
  expect(frames()).toHaveLength(0);
  expect(button("Retry")).toHaveLength(0);
});

test("a relay page read that fails after its stat answered offers Retry, which reads the page again", async () => {
  // Given a relay PC whose stat answers and whose first page read is refused in transit
  const relay = pc("relay", [html(4096)], [() => new Response("relay unavailable", { status: 500 }), () => new Response("<!doctype html><p>diagram</p>", { headers: { "content-type": "text/html" } })]);
  await show(relay.transport);
  // Then the preview says so once, with a Retry beside it
  await until(() => button("Retry").length === 1);
  expect(shown().split("The PC could not read the file. Reopen it to try again.")).toHaveLength(2);
  expect(frames()).toHaveLength(0);
  expect(relay.reads()).toBe(1);

  // When Retry is pressed
  await press("Retry");
  // Then the file is looked up and read again, and the page is handed to the render host
  await until(() => frames().length === 1);
  expect(frames()[0]!.props["src"]).toBe("/s/shell/~render");
  expect([relay.stats(), relay.reads()]).toEqual([2, 2]);
  expect(button("Retry")).toHaveLength(0);

  // When the row scrolls away and is drawn again
  await act(async () => renderer?.unmount());
  await draw(relay.transport);
  await until(() => frames().length === 1);
  // Then the page kept from the first download is drawn: the lookup tells its revision, and nothing is downloaded again
  expect([relay.stats(), relay.reads()]).toEqual([3, 2]);
});

test("a relay page past what the relay carries to this device says so, with no retry", async () => {
  // Given a relay PC whose rendered page (the file with its folder's pictures in it) is past the relay's limit
  const relay = pc("relay", [html(4096)], [() => new Response("", { headers: { "content-length": String(RELAY_BLOB_LIMIT + 1) } })]);
  await show(relay.transport);
  await until(() => shown().includes("Too large to open on the phone - download on the PC"));
  expect(button("Retry")).toHaveLength(0);
  expect(frames()).toHaveLength(0);
});

test("only a chat answer's Markdown asks for references to be drawn", () => {
  // every other Markdown (prompt cards, task results, release notes, the file viewer's Preview) keeps a reference as text
  const src = join(import.meta.dir, "..");
  const asking = (readdirSync(src, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap((file) => readFileSync(join(src, file), "utf8").split("\n").filter((line) => /<Markdown\b[^>]*\bvisualizations\b/.test(line)).map((line) => [file, line.trim()] as const));
  expect(asking.map(([file]) => file)).toEqual([join("components", "ChatView.tsx")]);
  expect(asking[0]![1]).toStartWith("? <Markdown key={`answer:");
});
