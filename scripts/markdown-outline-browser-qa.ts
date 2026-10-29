/**
 * A long Markdown file's contents (#636), in the real viewer and a real browser: the headings as
 * rendered (their levels, a repeated title its own entry), the heading being read marked as the
 * body scrolls and kept in the middle of the contents without moving the body or the focus, a jump
 * to the second of two equal titles, and on a phone a drawer over the body that opens on the
 * heading being read.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";

const section = (title: string, level = 2) => `${"#".repeat(level)} ${title}\n\n${"A paragraph to read through before the next heading. ".repeat(8)}\n\n`;
const sections = Array.from({ length: 48 }, (_, index) => section(`Topic ${index + 1}`, index % 3 === 2 ? 3 : 2));
const guide = [
  "# Guide\n\nAn opening paragraph before any section.\n\n",
  section("Install"),
  section("Linux", 3),
  section("Usage"),
  section("Options", 4),
  ...sections.slice(0, 24),
  // a title the document repeats: each is its own entry, and each jumps to its own heading
  section("Usage"),
  ...sections.slice(24),
  section("Last words"),
  "A short closing paragraph.\n",
].join("");
const short = "# Notes\n\nOne heading only, nothing to find.\n";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-outline-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/markdown-outline-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  const files: Record<string, string> = { "/docs/guide.md": guide, "/docs/notes.md": short };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), path = url.searchParams.get("path") ?? "";
    const text = files[path];
    if (url.pathname === "/api/fs/stat") return text === undefined
      ? Response.json({ error: "missing" }, { status: 404 })
      : Response.json({ path, name: path.split("/").pop(), kind: "text", size: Buffer.byteLength(text), mime: "text/markdown", modified: "2026-01-01T00:00:00Z" });
    if (url.pathname === "/api/fs/file") return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });

  const HEADINGS = ":is(.markdown-h1, .markdown-h2, .markdown-h3, .markdown-h4, .markdown-h5, .markdown-h6)";
  const errors: string[] = [];
  const openPage = async (theme: "dark" | "light", width: number, height: number): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width, height } }); page.setDefaultTimeout(10_000);
    await page.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), theme);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server!.port}`);
    return page;
  };
  const open = async (page: Page, path: string, as: "popup" | "page" | "docked" = "popup", last = "Last words") => {
    await page.evaluate(({ path, as }) => window.outlineQA.open(path, as), { path, as });
    // every chunk of the progressive renderer is drawn once the document's last heading is
    await page.locator(`.file-viewer-markdown ${HEADINGS}`).filter({ hasText: last }).waitFor();
  };
  /** The body scrolled so heading `index` sits `offset` px under its top edge; returns the scrollTop it set. */
  const scrollToHeading = (body: Locator, index: number, offset = 40) => body.evaluate((node, { index, offset, HEADINGS }) => {
    const heading = node.querySelectorAll<HTMLElement>(`.file-viewer-markdown ${HEADINGS}`)[index]!;
    node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top - offset;
    return node.scrollTop;
  }, { index, offset, HEADINGS });
  const currentIndex = (nav: Locator) => nav.locator("button").evaluateAll((buttons) => buttons.findIndex((button) => button.getAttribute("aria-current") === "location"));
  const waitCurrent = (page: Page, index: number) => page.waitForFunction((index) => {
    const buttons = [...document.querySelectorAll("nav.markdown-outline button")];
    return buttons.findIndex((button) => button.getAttribute("aria-current") === "location") === index;
  }, index);
  /** How far the current entry's middle is from the middle of the contents' scroll box, and whether that box is at an end. */
  const centring = (nav: Locator) => nav.locator("ol").evaluate((list) => {
    const current = list.querySelector<HTMLElement>('[aria-current="location"]')!;
    const box = list.getBoundingClientRect(), row = current.getBoundingClientRect();
    return { off: Math.abs(row.top + row.height / 2 - (box.top + box.height / 2)), top: list.scrollTop, max: list.scrollHeight - list.clientHeight };
  });

  {
    // desktop: the popup, its contents a rail beside the document
    const page = await openPage("dark", 1280, 900);
    await open(page, "/docs/guide.md");
    const nav = page.getByRole("navigation", { name: "Contents" });
    await nav.waitFor();
    const rendered = await page.locator(`.file-viewer-markdown ${HEADINGS}`).evaluateAll((headings) => headings.map((heading) => ({
      level: Number([...heading.classList].find((name) => /^markdown-h[1-6]$/.test(name))!.slice(-1)), title: heading.textContent!.trim(),
    })));
    const listed = await nav.locator("button").evaluateAll((buttons) => buttons.map((button) => ({ level: Number(button.closest("li")!.dataset.level), title: button.textContent!.trim() })));
    assert.deepEqual(listed, rendered, "the contents list every rendered heading at its level, in order");
    assert.equal(listed.filter((entry) => entry.title === "Usage").length, 2, "a repeated title is listed once for each heading");
    assert.equal(await page.getByRole("button", { name: "Contents" }).count(), 0, "with room for the rail there is no drawer to open");
    const doc = await page.locator(".file-viewer-markdown").boundingBox(), rail = await nav.boundingBox();
    assert.ok(doc && rail && rail.x >= doc.x + doc.width, "the rail stands beside the document, not over it");

    const body = page.locator(".file-viewer-body");
    const focused = await page.evaluate(() => document.activeElement?.className ?? null);
    const middle = Math.floor(listed.length / 2);
    const set = await scrollToHeading(body, middle);
    await waitCurrent(page, middle);
    const centred = await centring(nav);
    assert.ok(centred.max > 0, "the fixture's contents are longer than their box");
    assert.ok(centred.off <= 2 && centred.top > 0 && centred.top < centred.max, `the heading being read sits in the middle of the contents (${JSON.stringify(centred)})`);
    assert.equal(await body.evaluate((node) => node.scrollTop), set, "following the body never moves the body");
    assert.equal(await page.evaluate(() => document.activeElement?.className ?? null), focused, "following the body never moves the focus");

    await scrollToHeading(body, 1);
    await waitCurrent(page, 1);
    assert.equal((await centring(nav)).top, 0, "near the start the contents stop at their top");
    await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await waitCurrent(page, listed.length - 1);
    const end = await centring(nav);
    assert.equal(end.top, end.max, "at the end the contents stop at their bottom");

    // the second "Usage" jumps to its own heading, which takes the focus
    const second = listed.map((entry, index) => entry.title === "Usage" ? index : -1).filter((index) => index >= 0)[1]!;
    await nav.locator("button").nth(second).click();
    await waitCurrent(page, second);
    const landed = await body.evaluate((node, { second, HEADINGS }) => {
      const heading = node.querySelectorAll<HTMLElement>(`.file-viewer-markdown ${HEADINGS}`)[second]!;
      return { gap: heading.getBoundingClientRect().top - node.getBoundingClientRect().top, focused: document.activeElement === heading };
    }, { second, HEADINGS });
    assert.ok(landed.gap >= 0 && landed.gap <= 24, `the jump puts that heading at the top of the body (${landed.gap}px)`);
    assert.ok(landed.focused, "the heading jumped to takes the focus");
    if (evidence) await page.screenshot({ path: join(evidence, "outline-desktop-popup-dark.png") });

    // a document with one heading has nothing to list
    await open(page, "/docs/notes.md", "popup", "Notes");
    assert.equal(await page.getByRole("navigation", { name: "Contents" }).count(), 0, "one heading: no contents");
    await page.close();
  }

  {
    // a phone: no room beside the document, so a drawer over it, opened from the header
    const page = await openPage("dark", 390, 844);
    await open(page, "/docs/guide.md");
    const toggle = page.getByRole("button", { name: "Contents" });
    await toggle.waitFor();
    const nav = page.getByRole("navigation", { name: "Contents" });
    assert.equal(await nav.isVisible(), false, "the drawer starts closed");
    const body = page.locator(".file-viewer-body");
    const width = async () => page.locator(".file-viewer-markdown").evaluate((node) => node.getBoundingClientRect().width);
    const before = await width();
    const count = await page.locator(`.file-viewer-markdown ${HEADINGS}`).count();
    const reading = Math.floor(count / 2);
    await scrollToHeading(body, reading);
    await toggle.click();
    await nav.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await width(), before, "the drawer lies over the document without narrowing it");
    assert.equal(await currentIndex(nav), reading);
    assert.ok((await centring(nav)).off <= 2, "the drawer opens on the heading being read, in its middle");
    if (evidence) await page.screenshot({ path: join(evidence, "outline-phone-drawer-dark.png") });
    await page.keyboard.press("Escape");
    await nav.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog").count(), 1, "Escape closes the drawer, not the file");
    assert.ok(await toggle.evaluate((node) => node === document.activeElement), "the focus returns to the toggle");

    // read on, then reopen: the drawer opens on the new heading
    const later = reading + 10;
    await scrollToHeading(body, later);
    await toggle.click();
    await nav.waitFor();
    await waitCurrent(page, later);
    assert.ok((await centring(nav)).off <= 2, "reopened, the drawer is on the heading now being read");
    // an entry chosen in the drawer jumps there and closes it
    await nav.locator("button").nth(2).click();
    await nav.waitFor({ state: "hidden" });
    const gap = await body.evaluate((node, { HEADINGS }) => node.querySelectorAll<HTMLElement>(`.file-viewer-markdown ${HEADINGS}`)[2]!.getBoundingClientRect().top - node.getBoundingClientRect().top, { HEADINGS });
    assert.ok(gap >= 0 && gap <= 24, `the chosen heading is at the top (${gap}px)`);
    await page.close();
  }

  {
    // the reader page at desktop width keeps the rail, and the docked panel (too narrow) the drawer
    const page = await openPage("light", 1280, 900);
    await open(page, "/docs/guide.md", "page");
    await page.getByRole("navigation", { name: "Contents" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Contents" }).count(), 0, "the reader page at 1280px has the rail");
    if (evidence) await page.screenshot({ path: join(evidence, "outline-desktop-reader-light.png") });
    await open(page, "/docs/guide.md", "docked");
    const toggle = page.locator(".file-viewer-toolbar").getByRole("button", { name: "Contents" });
    await toggle.waitFor();
    await toggle.click();
    await page.getByRole("navigation", { name: "Contents" }).waitFor();
    await page.close();
  }

  if (evidence) for (const theme of ["light", "dark"] as const) {
    const desktop = await openPage(theme, 1280, 900);
    await open(desktop, "/docs/guide.md");
    await scrollToHeading(desktop.locator(".file-viewer-body"), 20);
    await waitCurrent(desktop, 20);
    await desktop.screenshot({ path: join(evidence, `outline-desktop-${theme}.png`) });
    await desktop.close();
    const phone = await openPage(theme, 390, 844);
    await open(phone, "/docs/guide.md");
    await scrollToHeading(phone.locator(".file-viewer-body"), 20);
    await phone.screenshot({ path: join(evidence, `outline-phone-closed-${theme}.png`) });
    await phone.getByRole("button", { name: "Contents" }).click();
    await waitCurrent(phone, 20);
    await phone.screenshot({ path: join(evidence, `outline-phone-${theme}.png`) });
    await phone.close();
  }
  assert.deepEqual(errors, []);
  console.log("markdown outline: browser OK (levels and repeated titles, the heading being read followed and centred without moving the body or focus, ends clamped, jump and focus, phone drawer over the body reopening on the current heading, reader rail, docked drawer)");
} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
