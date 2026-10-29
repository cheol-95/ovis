/**
 * The agent entry points for people who already use Ovis, on the unmodified app over the demo's
 * fixture transport (no herdr), at 1280 and 390, dark and light:
 *
 * - New workspace's agent picker ends with Add another agent…, which lists only the catalog agents
 *   the demo PC lacks, opens the chosen one's setup card, and Back returns the focus to the picker;
 *   New worktree's picker ends with the same row.
 * - Settings → Agent integrations lists Installed (with versions) and Can be installed (Install opens
 *   the card), with herdr's integrations still below. Sign in on an installed agent opens the card at
 *   its sign-in; Skip and Start open New workspace with that agent picked for that opening only.
 * - Settings → Setup guide lists its four steps, and Open setup guide closes Settings and asks for
 *   the guide once (lib/setupGuide.ts).
 * - A device that only watches (`?demo_devices=watch`) gets no Add another agent… and no Install or
 *   Sign in: a setup types into a terminal on the PC, which it may not do.
 *
 * With UI_EVIDENCE_DIR, each step is captured under agent-entry-points/.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-agent-entry-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "agent-entry-points") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
/** the agents the demo PC has (site/demo/fixtures.ts DEMO_INSTALLED), in the catalog's order */
const INSTALLED = ["Claude Code", "Codex", "Oh My Pi", "pi", "Hermes"];
const ADD_ROW = "Add another agent…";
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const root = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390] as const) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${width}-${theme}`;
      const context = await browser.newContext(width === 390
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: theme }
        : { viewport: { width: 1280, height: 800 }, locale: "en-US", colorScheme: theme });
      await context.addInitScript((value) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, palette: "codex", darkTheme: "codex", lightTheme: "codex" })); }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string): Promise<void> => {
        if (!evidence) return;
        await settled(page);
        await page.screenshot({ path: join(evidence, `${name}-${at}.png`) });
      };
      const press = (locator: ReturnType<Page["locator"]>) => width === 390 ? locator.tap() : locator.click();
      try {
        const base = `${root}&demo_devices=empty`;
        // New workspace: the row is the picker's last, its list is what the PC lacks, then the card
        await page.goto(`${base}&new=workspace`);
        const dialog = page.getByRole("dialog", { name: /^New workspace · / });
        await dialog.waitFor();
        await press(dialog.locator(".agent-picker-trigger"));
        const options = page.getByRole("option");
        await options.last().waitFor();
        assert.equal((await options.last().textContent())?.trim(), ADD_ROW, `the picker's last row ${at}`);
        await options.last().scrollIntoViewIfNeeded();
        await shot("1-picker");
        await press(options.last());
        await dialog.locator(".add-agent-row").first().waitFor();
        const names = await dialog.locator(".add-agent-name").allTextContents();
        assert.ok(names.length > 0 && names.every((name) => !INSTALLED.includes(name)), `only agents the demo PC lacks: ${names.join(", ")} ${at}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll ${at}`);
        await shot("2-add-list");
        await press(dialog.locator(".add-agent-row").first());
        await dialog.locator(".agent-setup").waitFor();
        assert.equal(await dialog.locator(".agent-setup-title h2").textContent(), names[0], `the card is the picked agent's ${at}`);
        await shot("3-add-card");
        await press(dialog.getByRole("button", { name: "Other agents", exact: true }));
        await press(dialog.getByRole("button", { name: "Back", exact: true }));
        await dialog.locator(".agent-picker-trigger").waitFor();
        await page.waitForFunction(() => document.activeElement?.classList.contains("agent-picker-trigger") ?? false);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        console.log(`PASS Add another agent… lists ${names.length} agents the PC lacks, opens ${names[0]}'s card, and Back returns to the picker (${at})`);

        // Settings → Agent integrations
        await page.goto(`${base}&settings=integrations`);
        const body = page.locator(".settings-body:not([hidden])");
        await body.locator(".settings-agent-row").first().waitFor();
        const installed = await body.locator("[data-section='agents-installed'] .settings-agent-row").evaluateAll((rows) => rows.map((row) => ({ name: row.querySelector(".settings-label")?.textContent ?? "", version: row.querySelector(".settings-agent-version")?.textContent ?? "" })));
        assert.deepEqual(installed.map((row) => row.name), INSTALLED, `Installed ${at}`);
        assert.ok(installed.every((row) => /^\d+\.\d+/.test(row.version)), `each installed agent has its version ${at}: ${JSON.stringify(installed)}`);
        const installs = body.locator("[data-section='agents-available'] .settings-agent-install");
        assert.ok(await installs.count() > 0, `Can be installed has Install buttons ${at}`);
        assert.ok(await body.locator(".settings-row:not(.settings-agent-row) code").count() > 0, `herdr's integrations are still below ${at}`);
        assert.equal(await body.getByRole("group", { name: "Show" }).count(), 0, `no kind filter ${at}`);
        await shot("4-settings-agents");
        await press(installs.first());
        await body.locator(".agent-setup").waitFor();
        await shot("5-settings-install");
        await press(body.getByRole("button", { name: "All agents", exact: true }));
        await body.locator(".settings-agent-row").first().waitFor();
        // Sign in resumes at the card's sign-in; Start picks the agent for that opening only
        await page.evaluate(() => localStorage.setItem("ovis:new-session-agent", ""));
        await press(body.getByRole("button", { name: "Sign in to Codex", exact: true }));
        await body.locator(".agent-setup").waitFor();
        assert.equal(await body.locator(".agent-setup-status strong").textContent(), "Sign in to Codex", `the card opens at sign-in ${at}`);
        await shot("6-settings-sign-in");
        await press(body.getByRole("button", { name: "Skip", exact: true }));
        await press(body.getByRole("button", { name: "Start Codex", exact: true }));
        const started = page.getByRole("dialog", { name: /^New workspace · / });
        await started.waitFor();
        assert.equal((await started.locator(".agent-picker-label").textContent())?.trim(), "Codex", `New workspace opens with Codex picked ${at}`);
        assert.equal(await page.evaluate(() => localStorage.getItem("ovis:new-session-agent")), "", `the remembered agent is left alone ${at}`);
        await page.keyboard.press("Escape");
        await started.waitFor({ state: "detached" });
        console.log(`PASS Settings lists ${installed.map((row) => `${row.name} ${row.version}`).join(", ")}; Install and Sign in open the card; Start opens New workspace with Codex (${at})`);

        // Settings → Setup guide
        await page.goto(`${base}&settings=guide`);
        await page.waitForFunction(() => {
          const steps = [...document.querySelectorAll(".settings-guide-steps li")];
          return steps.length === 4 && steps.every((step) => step.textContent !== "Loading…");
        });
        const steps = await page.locator(".settings-guide-steps li").allTextContents();
        assert.deepEqual(steps.map((step) => step.split(":")[0]), ["Agent", "Plan usage", "Phone", "Alerts"], `the guide's four steps ${at}`);
        await shot("7-settings-guide");
        await page.evaluate(() => {
          const counted = window as unknown as { asked: number };
          counted.asked = 0;
          window.addEventListener("ovis:open-setup-guide", () => { counted.asked += 1; });
        });
        assert.equal(await page.getByRole("region", { name: "Setup guide", exact: true }).count(), 0, `an existing user's app shows no guide by itself ${at}`);
        await press(page.getByRole("button", { name: "Open setup guide", exact: true }));
        await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => (window as unknown as { asked: number }).asked), 1, `Open setup guide asks for the guide once ${at}`);
        // the first-run guide (components/SetupGuide.tsx) answers it: open again, on one of its steps
        const guide = page.getByRole("region", { name: "Setup guide", exact: true });
        await guide.waitFor();
        await guide.locator("#setup-step-title").waitFor();
        const stepTitle = (await guide.locator("#setup-step-title").textContent())?.trim() ?? "";
        assert.ok(stepTitle !== "", `the guide opens on a step ${at}`);
        await shot("9-guide-reopened");
        console.log(`PASS Setup guide shows ${steps.join(" | ")}; Open setup guide opens the guide on "${stepTitle}" (${at})`);

        if (width === 1280) {
          // New worktree, from a repository row's menu
          await page.goto(base);
          const row = page.locator(`.workspace-group[data-workspace="${panes.api.split(":")[0]}"] > .workspace-header .workspace-select`);
          const bounds = (await row.boundingBox())!;
          await row.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
          await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
          const worktree = page.getByRole("dialog", { name: /^New worktree · / });
          await worktree.waitFor();
          await worktree.locator(".agent-picker-trigger").click();
          await options.last().waitFor();
          assert.equal((await options.last().textContent())?.trim(), ADD_ROW, `New worktree's last row ${at}`);
          await options.last().scrollIntoViewIfNeeded();
          await shot("8-worktree-picker");
          await options.last().click();
          await worktree.locator(".add-agent-row").first().waitFor();
          console.log(`PASS New worktree's picker ends with ${ADD_ROW} (${at})`);
        }

        // a device that only watches may not type into the PC's terminal: no setup anywhere
        await page.goto(`${root}&demo_devices=watch&new=workspace`);
        const watched = page.getByRole("dialog", { name: /^New workspace · / });
        await watched.waitFor();
        await press(watched.locator(".agent-picker-trigger"));
        await options.last().waitFor();
        const offered = (await options.allTextContents()).map((text) => text.trim());
        assert.ok(offered.length > 1, `a watching device still sees the agents ${at}`);
        assert.ok(!offered.includes(ADD_ROW), `a watching device gets no ${ADD_ROW} ${at}: ${offered.join(", ")}`);
        await page.keyboard.press("Escape");
        await page.goto(`${root}&demo_devices=watch&settings=integrations`);
        await body.locator(".settings-agent-row").first().waitFor();
        assert.equal(await body.locator(".settings-agent-install").count(), 0, `a watching device gets no Install or Sign in ${at}`);
        // the guide is never shown to a watching device (#2332), so Settings offers no button that would do nothing
        await page.goto(`${root}&demo_devices=watch&settings=guide`);
        await page.locator(".settings-guide-steps li").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "Open setup guide", exact: true }).count(), 0, `a watching device gets no Open setup guide ${at}`);
        console.log(`PASS a watching device lists the agents but gets no ${ADD_ROW}, Install, Sign in or Open setup guide (${at})`);

        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
