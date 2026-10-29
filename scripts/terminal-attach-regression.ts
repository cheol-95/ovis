/**
 * Attach files from a phone's terminal lens (#1633), through the real picker, route and pane: in
 * the input line the picked files land beside the pane and their quoted paths join the line where
 * its caret is, with nothing sent; a file over the limit says why and uploads nothing; in direct
 * typing the key bar's Attach files types the paths into the terminal with no Enter, as a drop
 * does. An owned workspace in the test herdr, a loopback server on port 0 and a temp directory;
 * nothing touches the user's own session. With UI_EVIDENCE_DIR set, each state is captured.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-attach-")));
const owned: string[] = [];
const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state"), token: "" });
let launched: Browser | undefined;
const errors: string[] = [];
const evidence = process.env.UI_EVIDENCE_DIR || undefined;
if (evidence) mkdirSync(evidence, { recursive: true });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;
const unbracket = (text: string): string => text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
const shot = async (page: Page, name: string): Promise<void> => {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
};

try {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const made = await workspaceCreate({ cwd, label: "ovis-test-attach", focus: false });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const browser = launched = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript((paneId) => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`ovis:view:${paneId}`, "terminal");
  }, pane);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const typed: { type: string; text?: string }[] = [];
  let onTyped: (() => void) | null = null;
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload)) as { type: string; text?: string };
    if (!["input", "submit", "insert", "keys"].includes(frame.type)) return;
    typed.push(frame);
    onTyped?.();
  }));
  /** resolves once an input frame was sent after `from`, armed before the action that sends it */
  const inputAfter = (from: number): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTyped = null; reject(new Error("no input frame reached the terminal")); }, 10_000);
    onTyped = () => {
      if (!typed.slice(from).some((frame) => frame.type === "input")) return;
      clearTimeout(timer);
      onTyped = null;
      resolve();
    };
  });
  const uploads: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/pane/image")) uploads.push(request.postDataJSON().name); });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();

  // the input line: Attach opens the system picker from its tap; the line keeps its text and caret
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  const attach = page.getByRole("button", { name: "Attach files", exact: true });
  await line.waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-attach")?.disabled === false);
  assert.equal(await page.locator('.key-bar [data-key="attach"]').count(), 0, "the input line carries Attach; the key bar has none beside it");
  await line.fill("cat  | wc -c");
  await line.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(4, 4));
  // the first upload is held, to read the note that says the files are on their way
  let releaseUpload: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let heldOnce = false;
  await page.route("**/api/pane/image", async (route) => {
    if (!heldOnce) { heldOnce = true; await held; }
    await route.continue();
  });
  const beforeLine = typed.length;
  const answered = Promise.all([0, 1].map((index) => page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().postDataJSON().name === ["screen shot.png", "notes.txt"][index])));
  const chooser = page.waitForEvent("filechooser");
  await attach.tap();
  const picker = await chooser;
  assert.equal(picker.isMultiple(), true, "the picker takes several files");
  await picker.setFiles([
    { name: "screen shot.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("build failed at step 3\n") },
  ]);
  await page.locator(".pane-frame.is-current .terminal-input-note.is-pending", { hasText: "Uploading files…" }).waitFor();
  assert.equal(await attach.isDisabled(), true, "Attach waits while the files are on their way");
  await shot(page, "line-uploading");
  releaseUpload!();
  const [image, text] = await Promise.all((await answered).map(async (response) => {
    assert.equal(response.status(), 200);
    return ((await response.json()) as { path: string }).path;
  }));
  await page.unroute("**/api/pane/image");
  for (const [path, bytes] of [[image!, PNG], [text!, Buffer.from("build failed at step 3\n")]] as const) {
    assert.equal(dirname(path), join(cwd, ".ovis"), "stored beside the pane, in its folder's .ovis");
    assert.ok(existsSync(path), `${path} is on disk`);
    assert.deepEqual(readFileSync(path), bytes, `${path} holds the picked bytes`);
  }
  assert.match(text!, /notes-.*\.txt$/);
  const expected = `cat ${quote(image!)} ${quote(text!)} | wc -c`;
  await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text")?.value === value, expected);
  // the line places its caret in the frame after it renders the paths
  await page.waitForFunction((caret) => {
    const element = document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text");
    return element !== null && document.activeElement === element && element.selectionStart === caret && element.selectionEnd === caret;
  }, `cat ${quote(image!)} ${quote(text!)} `.length);
  assert.equal(await page.locator(".pane-frame.is-current .terminal-input-note").count(), 0, "the note goes once the paths are in");
  assert.equal(await attach.isDisabled(), false);
  assert.deepEqual(typed.slice(beforeLine), [], "attaching sends nothing to the terminal");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways overflow at 390");
  await shot(page, "line-attached");
  console.log("PASS the input line's Attach files stores the picked files beside the pane and puts their quoted paths at the caret, sending nothing");

  // a file over the limit: said with its name and the limit, and nothing is uploaded or written
  const before = { uploads: uploads.length, value: await line.inputValue() };
  const tooLarge = page.waitForEvent("filechooser");
  await attach.tap();
  await (await tooLarge).setFiles([
    { name: "small.txt", mimeType: "text/plain", buffer: Buffer.from("ok") },
    { name: "recording.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
  ]);
  await page.locator(".pane-frame.is-current .terminal-input-note[role=alert]", { hasText: "Too large to attach: recording.mov" }).waitFor();
  assert.equal(uploads.length, before.uploads, "one file too large and none of the batch is uploaded");
  assert.equal(await line.inputValue(), before.value, "the line is left as it was");
  await shot(page, "line-too-large");
  console.log("PASS a file over the limit says why, and nothing of its batch is uploaded or put in the line");

  // direct typing: the key bar's Attach files, after the keyboard control, types the paths into the pane
  await line.fill("");
  await page.getByRole("button", { name: "Input line", exact: true }).tap();
  await page.locator("[data-direct-typing]").waitFor();
  const key = page.locator('.pane-frame.is-current .key-bar [data-key="attach"]');
  await key.waitFor();
  assert.equal(await page.locator(".terminal-input-attach").count(), 0);
  assert.ok(await key.evaluate((element) => element.previousElementSibling?.getAttribute("data-key") === "keyboard"), "Attach files follows the keyboard control");
  const beforeDirect = typed.length;
  const reached = inputAfter(beforeDirect);
  const stored = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().postDataJSON().name === "trace.log");
  const directChooser = page.waitForEvent("filechooser");
  await key.tap();
  await (await directChooser).setFiles([{ name: "trace.log", mimeType: "text/plain", buffer: Buffer.from("trace\n") }]);
  const response = await stored;
  assert.equal(response.status(), 200);
  const log = ((await response.json()) as { path: string }).path;
  assert.deepEqual(readFileSync(log), Buffer.from("trace\n"));
  await reached;
  const sent = typed.slice(beforeDirect);
  assert.deepEqual(sent.map((frame) => frame.type), ["input"], "one input frame, no submit and no keys");
  assert.equal(unbracket(sent[0]!.text!), `${quote(log)} `, "the quoted path and a space, with no Enter");
  await shot(page, "direct-attached");
  console.log("PASS the key bar's Attach files in direct typing types the quoted path into the terminal with no Enter");

  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await launched?.close();
  server.stop();
  for (const id of owned) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
