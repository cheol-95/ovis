import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { FileInfo } from "../../shared/protocol.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { MAX_INLINE_IMAGE_BYTES } from "../lib/markdownImages.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatMarkdownImages } from "./ChatMarkdownImages.tsx";
import { InlineMarkdown, Markdown } from "./Markdown.tsx";

let renderer: ReactTestRenderer | undefined;
let requests: Array<{ url: URL; finish: (body: unknown, status?: number) => void }>;
let opened: GalleryImage[];
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const onOpen = (image: GalleryImage) => { opened.push(image); };
const info = (path: string, size = 100): FileInfo => ({ path, name: path.split("/").pop()!, size, modified: "2026-10-30T00:00:00Z", mime: "image/png", kind: "image" });

async function draw({ machine = "local", pane = "w1:p1", cwd = "/project", connected = true, text = "![Diagram](./diagram.png)", inline = false, html = false }: {
  machine?: string; pane?: string; cwd?: string | null; connected?: boolean; text?: string; inline?: boolean; html?: boolean;
} = {}) {
  const children = inline ? createElement(InlineMarkdown, { children: text }) : createElement(Markdown, { children: text, html });
  const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: machine,
    children: createElement(ChatMarkdownImages, { paneId: pane, cwd, connected, onOpen, children }),
  }) });
  await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree); });
}
const images = () => renderer!.root.findAllByType("img");
const buttons = () => renderer!.root.findAllByType("button");
async function answer(index: number, body: unknown, status = 200) {
  await act(async () => { requests[index]!.finish(body, status); });
}

beforeEach(() => {
  for (const key of ["window", "document", "getComputedStyle", "fetch", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  descriptors.set("languages", Object.getOwnPropertyDescriptor(navigator, "languages"));
  const listeners = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  requests = [];
  opened = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (target: string) => new Promise<Response>((resolve) => {
    requests.push({ url: new URL(target, "http://test.local"), finish: (body, status = 200) => resolve(Response.json(body, { status })) });
  }) });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    const target = key === "languages" ? navigator : globalThis;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  descriptors.clear();
});

it("stats and opens an answer's image on its owning PC and pane, retaining the real filename", async () => {
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests[0]!.url.pathname).toBe("/api/machines/other-pc/fs/stat");
  expect(requests[0]!.url.searchParams.get("path")).toBe("/project/out/chart #?.png");
  expect(requests[0]!.url.searchParams.get("pane_id")).toBe("w2:p4");
  expect(images()).toHaveLength(0);
  await answer(0, info("/project/out/chart #?.png"));
  const src = new URL(images()[0]!.props.src, "http://test.local");
  expect(src.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(src.searchParams.get("pane_id")).toBe("w2:p4");
  expect(src.searchParams.get("path")).toBe("/project/out/chart #?.png");
  let focused = false;
  expect(buttons()[0]!.props["aria-label"]).toBe("Diagram");
  await act(async () => { buttons()[0]!.props.onClick({ currentTarget: { focus() { focused = true; } } }); });
  expect(focused).toBe(true);
  expect(opened).toEqual([{ src: images()[0]!.props.src, name: "Diagram", file: "chart #?.png" }]);
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests).toHaveLength(1);
});

it("discards a late answer from the old PC and hides old bytes while the pane or cwd changes", async () => {
  await draw({ machine: "old" });
  await draw({ machine: "new" });
  await answer(1, info("/project/diagram.png"));
  expect(images()[0]!.props.src).toContain("/api/machines/new/");
  await answer(0, info("/old/diagram.png"));
  expect(images()[0]!.props.src).toContain("/api/machines/new/");
  await draw({ machine: "new", pane: "w2:p2", cwd: "/next" });
  expect(images()).toHaveLength(0);
  expect(requests[2]!.url.searchParams.get("path")).toBe("/next/diagram.png");
  expect(requests[2]!.url.searchParams.get("pane_id")).toBe("w2:p2");
  await answer(2, info("/next/diagram.png"));
  expect(new URL(images()[0]!.props.src, "http://test.local").searchParams.get("pane_id")).toBe("w2:p2");
});

it("never guesses a relative image's folder without cwd, but reads absolute paths and file URIs", async () => {
  await draw({ cwd: null });
  expect(requests).toHaveLength(0);
  expect(images()).toHaveLength(0);
  await draw({ cwd: null, text: "![Absolute](/tmp/a.png)\n\n![URI](file:///tmp/b%20c.png)" });
  expect(requests.map(({ url }) => url.searchParams.get("path"))).toEqual(["/tmp/a.png", "/tmp/b c.png"]);
  await answer(0, info("/tmp/a.png"));
  await answer(1, info("/tmp/b c.png"));
  expect(images()).toHaveLength(2);
});

it("offers an oversized image only as a download on the same PC and pane", async () => {
  await draw({ machine: "other-pc", pane: "w2:p4" });
  await answer(0, info("/project/diagram.png", MAX_INLINE_IMAGE_BYTES + 1));
  expect(images()).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
  const link = renderer!.root.findByType("a");
  const url = new URL(link.props.href, "http://test.local");
  expect(url.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(url.searchParams.get("pane_id")).toBe("w2:p4");
  expect(url.searchParams.get("download")).toBe("1");
});

it("keeps rejected stat results as text links and requests no image bytes", async () => {
  for (const [index, body, status] of [
    [0, { error: { message: "missing" } }, 404],
    [1, { error: { candidates: ["/one/a.png", "/two/a.png"] } }, 409],
    [2, { ...info("/project/a.png"), kind: "text" }, 200],
    [3, { error: { message: "denied" } }, 403],
  ] as const) {
    await draw({ text: `![Diagram](./${index}.png)` });
    await answer(index, body, status);
    expect(images()).toHaveLength(0);
    expect(buttons()).toHaveLength(0);
  }
  expect(requests.every(({ url }) => url.pathname === "/api/fs/stat")).toBe(true);
});

it("does not nest an image button inside an authored link or a read-only inline label", async () => {
  await draw({ text: '<p><a href="https://example.com"><img src="./badge.png" alt="Badge"></a></p>', html: true });
  await answer(0, info("/project/badge.png"));
  expect(images()).toHaveLength(1);
  expect(renderer!.root.findAllByType("a")).toHaveLength(1);
  expect(buttons()).toHaveLength(0);
  await draw({ text: "![Label](./label.png)", inline: true });
  expect(requests).toHaveLength(1);
  expect(images()).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
});

it("keeps a failed image's reserved slot and access to the viewer's download", async () => {
  await draw();
  await answer(0, info("/project/diagram.png"));
  await act(async () => { images()[0]!.props.onError(); });
  expect(images()).toHaveLength(0);
  expect(renderer!.root.findAll((node) => node.props.className === "image-slot is-failed")).toHaveLength(1);
  await act(async () => { buttons()[0]!.props.onClick({ currentTarget: { focus() {} } }); });
  expect(opened[0]!.file).toBe("diagram.png");
});

it("retries an offline stat on reconnect, keeping a decoded image when the connection drops", async () => {
  await draw({ connected: false });
  await answer(0, { error: { message: "offline" } }, 503);
  expect(images()).toHaveLength(0);
  await draw({ connected: false });
  expect(requests).toHaveLength(1);
  await draw({ connected: true });
  expect(requests).toHaveLength(2);
  await answer(1, info("/project/diagram.png"));
  const src = images()[0]!.props.src;
  await draw({ connected: false });
  expect(images()[0]!.props.src).toBe(src);
  expect(requests).toHaveLength(2);
  await draw({ connected: true });
  expect(requests).toHaveLength(3);
  expect(images()[0]!.props.src).toBe(src);
  await answer(2, info("/project/diagram.png"));
  expect(images()[0]!.props.src).toBe(src);
});
