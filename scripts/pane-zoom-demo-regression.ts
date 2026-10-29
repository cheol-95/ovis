import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Pane zoom on a desktop (#2037), on the unmodified app over the demo's fixture transport: no
// herdr session is opened. A split pane's head shows its Zoom button and its ellipsis to a mouse,
// a zoomed pane keeps its head with the title and an Unzoom pill, and a chord chosen in Settings
// zooms and unzooms the selected pane. A phone, which shows one pane at a time, draws no such head.
const app = mkdtempSync(join(tmpdir(), "herdr-pane-zoom-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const shell = panes.shell;

const layout = async (page: Page, path: string, body: Record<string, unknown>): Promise<void> => {
  const status = await page.evaluate(async ([url, payload]) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status,
    [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
};
const shown = (page: Page): Promise<number> => page.locator(".pane-frame:not(.is-hidden)").count();
async function until(page: Page, check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
}
async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `pane-zoom-${name}.png`), animations: "disabled" });
}

async function open(browser: Browser, origin: string, theme: "dark" | "light", phone: boolean): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" }
    : { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({
    language: "en", defaultView: "terminal", theme: value, darkTheme: "codex", lightTheme: "codex", shortcutOverrides: { "zoom-pane": "z" },
  })), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(shell)}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(`[data-layout-pane="${shell}"]`).waitFor();
  return { page, errors, close: () => context.close() };
}

async function checkDesktop(browser: Browser, origin: string, theme: "dark" | "light"): Promise<void> {
  const { page, errors, close } = await open(browser, origin, theme, false);
  try {
    await layout(page, "/api/pane/split", { pane_id: shell, direction: "right", focus: false });
    await until(page, async () => await shown(page) === 2, "the split draws both panes");
    const frame = page.locator(`[data-layout-pane="${shell}"]`);
    const zoomButton = frame.locator(".pane-frame-zoom");
    for (const control of [zoomButton, frame.locator(".pane-frame-menu")]) {
      await control.waitFor();
      assert.equal(await control.evaluate((node) => getComputedStyle(node).opacity), "1", "the split pane's head controls are shown to a mouse");
    }
    assert.equal(await zoomButton.getAttribute("title"), "Zoom pane (Ctrl+Shift+Z)", "the Zoom button names the chosen shortcut");
    assert.equal(await page.locator(".pane-frame-unzoom").count(), 0, "no Unzoom pill while every pane is shown");
    await shot(page, `split-1280-${theme}`);

    await zoomButton.click();
    await until(page, async () => await shown(page) === 1 && await frame.evaluate((node) => node.classList.contains("is-zoomed")), "the Zoom button zooms the pane");
    const title = frame.locator(".pane-frame-title");
    assert.equal(await title.isVisible(), true, "the zoomed pane keeps its title");
    const unzoom = frame.locator(".pane-frame-unzoom");
    assert.equal(await unzoom.isVisible(), true, "the zoomed pane shows Unzoom");
    assert.equal((await unzoom.textContent())?.trim(), "Unzoom pane");
    const head = await frame.locator(".pane-frame-head").boundingBox();
    const body = await frame.locator(".pane-frame-body").boundingBox();
    assert.ok(head && body && head.y + head.height <= body.y + 1, "the zoomed pane's head sits above its terminal, never over it");
    await shot(page, `zoomed-1280-${theme}`);

    await unzoom.click();
    await until(page, async () => await shown(page) === 2 && await page.locator(".pane-frame.is-zoomed").count() === 0, "Unzoom shows every pane again");

    await frame.locator(".pane-frame-body").click({ position: { x: 40, y: 40 } });
    await page.locator(`[data-layout-pane="${shell}"].is-current`).waitFor();
    await page.keyboard.press("Control+Shift+Z");
    await until(page, async () => await shown(page) === 1 && await frame.evaluate((node) => node.classList.contains("is-zoomed")), "the shortcut zooms the selected pane");
    await page.keyboard.press("Control+Shift+Z");
    await until(page, async () => await shown(page) === 2 && await page.locator(".pane-frame.is-zoomed").count() === 0, "the shortcut unzooms it");
    assert.deepEqual(errors, []);
  } finally { await close(); }
}

async function checkPhone(browser: Browser, origin: string, theme: "dark" | "light"): Promise<void> {
  const { page, errors, close } = await open(browser, origin, theme, true);
  try {
    await layout(page, "/api/pane/split", { pane_id: shell, direction: "right", focus: false });
    await layout(page, "/api/pane/zoom", { pane_id: shell, mode: "on" });
    await until(page, async () => await shown(page) === 1, "the phone shows the zoomed pane");
    assert.equal(await page.locator(".pane-frame.is-zoomed").count(), 0, "a phone draws no zoomed head");
    assert.equal(await page.locator(".pane-frame-unzoom").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "nothing overflows the phone sideways");
    await shot(page, `zoomed-390-${theme}`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      for (const theme of ["dark", "light"] as const) {
        await checkDesktop(browser, origin, theme);
        await checkPhone(browser, origin, theme);
      }
      console.log("pane zoom: a split pane's Zoom button and ellipsis, the zoomed head's Unzoom and the chosen shortcut work at 1280; a phone draws no zoomed head");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
