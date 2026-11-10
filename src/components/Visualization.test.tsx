import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { Visualization } from "./Visualization.tsx";
import type { FileInfo } from "../../shared/files.ts";
import { VISUALIZATION_PAGE_BYTES } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { RELAY_BLOB_LIMIT } from "../lib/relay/resources.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, location: { pathname: "/s/shell/" }, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, activeElement: null, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const PATH = "/w/diagram.html";
const html = (size: number): FileInfo => ({ path: PATH, name: "diagram.html", size, modified: "2026-11-09T00:00:00Z", mime: "text/html", kind: "text" });

/** A PC holding `info`: its stat answers, and each read of the rendered page gets the next of `pages` (the last one again after that). */
function pc(kind: Transport["kind"], info: FileInfo, pages: Array<() => Response> = []): { transport: Transport; stats: () => number; reads: () => number } {
  let stats = 0, reads = 0;
  const transport: Transport = {
    ...nativeTransport,
    kind,
    fetch: async (input) => {
      if (String(input).includes("/api/fs/stat")) { stats += 1; return Response.json(info); }
      const page = pages[Math.min(reads, pages.length - 1)]!;
      reads += 1;
      return page();
    },
  };
  return { transport, stats: () => stats, reads: () => reads };
}

const shown = (): string => JSON.stringify(renderer?.toJSON());
const frames = (): ReactTestInstance[] => renderer?.root.findAllByType("iframe") ?? [];
const retry = (): ReactTestInstance[] => renderer?.root.findAll((node) => node.type === "button" && node.children.includes("Retry")) ?? [];

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

test("an HTML file up to the size the Page renderer keeps whole is previewed; a larger one says so and offers no retry", async () => {
  // Given a visualization of 2 MiB, as one with its pictures written into it is
  await draw(pc("native", html(2 * 1024 * 1024)).transport);
  await until(() => frames().length === 1);
  // Then it is drawn by the Page renderer
  expect(frames()[0]!.props["src"]).toContain("render=1");
  expect(frames()[0]!.props["sandbox"]).toBe("allow-scripts");
  await act(async () => renderer?.unmount());

  // Given one exactly at the limit, then one a byte past it
  await draw(pc("native", html(VISUALIZATION_PAGE_BYTES)).transport);
  await until(() => frames().length === 1);
  await act(async () => renderer?.unmount());
  const large = pc("native", html(VISUALIZATION_PAGE_BYTES + 1));
  await draw(large.transport);
  await until(() => shown().includes("Too large to preview here. Open the file to see it."));
  // Then the note names the size, nothing is loaded, another try would change nothing, and the file still opens from its title
  expect(frames()).toHaveLength(0);
  expect(retry()).toHaveLength(0);
  expect(shown()).not.toContain("The file could not be opened.");
  expect(renderer?.root.findAll((node) => node.type === "button" && node.props["title"] === `Open ${PATH}`)).toHaveLength(1);
  expect(large.reads()).toBe(0);
});

test("a relay page read that fails after its stat answered offers Retry, which reads the page again", async () => {
  // Given a relay PC whose stat answers and whose first page read is refused in transit
  const relay = pc("relay", html(4096), [() => new Response("relay unavailable", { status: 503 }), () => new Response("<!doctype html><p>diagram</p>", { headers: { "content-type": "text/html" } })]);
  await draw(relay.transport);
  // Then the preview says so once, with a Retry beside it
  await until(() => retry().length === 1);
  expect(shown().split("The file could not be opened.")).toHaveLength(2);
  expect(frames()).toHaveLength(0);
  expect(relay.reads()).toBe(1);

  // When Retry is pressed
  await act(async () => { (retry()[0]!.props["onClick"] as () => void)(); });
  // Then the file is looked up and read again, and the page is handed to the render host
  await until(() => frames().length === 1);
  expect(frames()[0]!.props["src"]).toBe("/s/shell/~render");
  expect([relay.stats(), relay.reads()]).toEqual([2, 2]);
  expect(retry()).toHaveLength(0);
});

test("a relay page past what the relay carries to this device says so, with no retry", async () => {
  // Given a relay PC whose rendered page (the file with its folder's pictures in it) is past the relay's limit
  const relay = pc("relay", html(4096), [() => new Response("", { headers: { "content-length": String(RELAY_BLOB_LIMIT + 1) } })]);
  await draw(relay.transport);
  await until(() => shown().includes("Too large to open on the phone - download on the PC"));
  expect(retry()).toHaveLength(0);
  expect(frames()).toHaveLength(0);
});
