/** Browser regression with the real Markdown component, file renderer and sandbox policy. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { fileInfo, fileResponse } from "../server/file-view.ts";
import { chromePath } from "./chrome-path.ts";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-visualization-qa-"));
const path = join(root, "before-after.html");
const directive = `\uE200visualize\uE202${JSON.stringify({ path, mode: "wide", title: "Transmission comparison" })}\uE201`;
const fragment = `<!doctype html><html><head><style>body{margin:0;padding:16px;background:#123456;color:white;font:15px system-ui}.viz-controls{display:flex;gap:8px;flex-wrap:wrap}.btn{padding:8px;background:transparent;color:inherit;border:1px solid currentColor}.btn[aria-pressed=true]{background:white;color:#123456}.card{padding:16px;border:1px solid currentColor}</style></head><body><div id="diagram"><h2>Before / After</h2><p id="scenario" aria-live="polite">Normal transmission</p>
<div class="viz-controls"><button class="btn" data-case="normal" aria-pressed="true">Normal</button><button class="btn" data-case="timeout" aria-pressed="false">Timeout</button><button class="btn" data-case="error" aria-pressed="false">Collector error</button></div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14em),1fr));gap:1em;margin-top:1em"><div class="card">Before: return without waiting</div><div class="card">After: wait for the flush</div></div></div>
<script>document.querySelectorAll('[data-case]').forEach(button=>button.onclick=()=>{document.querySelector('#scenario').textContent=button.textContent;document.querySelectorAll('[data-case]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));document.body.dataset.scenario=button.dataset.case;});</script></body></html>`;
writeFileSync(path, fragment);
let missing = false;
const stats: URL[] = [];
const reads: URL[] = [];
const build = await Bun.build({ entrypoints: ["scripts/chat-visualization-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/machines/fixture-pc/fs/stat") {
    stats.push(url);
    assert.equal(url.searchParams.get("path"), path);
    return missing ? Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 }) : Response.json(fileInfo(path));
  }
  if (url.pathname === "/api/machines/fixture-pc/fs/file") {
    reads.push(url);
    assert.equal(url.searchParams.get("path"), path);
    return fileResponse(fileInfo(path)!, false, url.searchParams.get("render") === "1", null, request);
  }
  if (url.pathname === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-visualization-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-visualization-fixture.js"></script></body></html>', { headers: { "content-security-policy": CONTENT_SECURITY_POLICY, "content-type": "text/html" } });
  if (/^\/chat-visualization-fixture\.(?:js|css)$/.test(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))));
  return new Response("not found", { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
if (process.argv.includes("--serve")) {
  console.log(JSON.stringify({ origin, path, directive }));
  await new Promise(() => {});
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } });
  await page.addInitScript(() => { if (window === top) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex" })); });
  const errors: string[] = [];
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.visualizationQa);
  await page.evaluate((text) => window.visualizationQa.update(`Intro\n${text}\nConclusion`), directive);
  const frame = page.frameLocator("iframe.markdown-visualization-frame");
  await frame.getByRole("button", { name: "Timeout", exact: true }).click();
  await frame.getByText("Timeout", { exact: true }).first().waitFor();
  assert.equal(await frame.locator("#scenario").textContent(), "Timeout");
  assert.equal(await frame.locator('[data-case="timeout"]').getAttribute("aria-pressed"), "true");
  assert.equal(reads[0]!.searchParams.get("render"), "1");
  assert.equal(reads[0]!.searchParams.has("visualize"), false);
  assert.ok(!await page.locator("body").innerText().then((text) => text.includes("\uE200visualize")));
  assert.equal(await frame.locator("body").evaluate(() => { try { return parent.document.cookie; } catch { return "blocked"; } }), "blocked");
  await page.waitForFunction(() => !document.querySelector('[role="status"]'));
  const ownBackground = await frame.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
  assert.equal(ownBackground, "rgb(18, 52, 86)", "the document keeps its own styles");
  await page.evaluate(() => document.documentElement.style.setProperty("--bg", "rgb(200, 100, 50)"));
  assert.equal(await frame.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor), ownBackground);
  assert.equal(await frame.locator("body").evaluate(() => typeof (window as unknown as { openai?: unknown }).openai), "undefined", "no host API is invented");
  const initialHeight = (await page.locator("iframe").boundingBox())!.height;
  await page.evaluate(() => window.postMessage({ type: "ovis-visualization-size", height: 999999 }, "*"));
  assert.equal((await page.locator("iframe").boundingBox())!.height, initialHeight, "unrelated windows cannot resize the preview");
  mkdirSync(".ci/visualization", { recursive: true });
  await page.screenshot({ path: ".ci/visualization/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await frame.locator("html").evaluate((html) => html.scrollWidth > innerWidth), false);
  await frame.getByRole("button", { name: "Collector error", exact: true }).click();
  assert.equal(await frame.locator("#scenario").textContent(), "Collector error");
  await page.screenshot({ path: ".ci/visualization/mobile.png" });
  await page.getByRole("button", { name: "Transmission comparison", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.visualizationQa.opened), [path]);
  missing = true;
  await page.reload();
  await page.waitForFunction(() => !!window.visualizationQa);
  await page.evaluate((text) => window.visualizationQa.update(text), directive);
  await page.getByRole("alert").waitFor();
  const before = stats.length;
  await page.evaluate((text) => window.visualizationQa.update(`Extra prose\n${text}`), directive);
  assert.equal(stats.length, before, "ordinary transcript updates do not loop failed file requests");
  missing = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.frameLocator("iframe").getByRole("button", { name: "Normal", exact: true }).waitFor();
  assert.equal(stats.length, before + 1);
  assert.deepEqual(errors, []);
  console.log("PASS original HTML/styles/controls preserved, no theme or host API injection, sandbox, PC ownership, 390px reflow, file opener and explicit retry");
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
