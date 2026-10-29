/**
 * POST /api/agent-catalog/install and /api/agent-catalog/sign-in: an agent's official install
 * command, or its sign-in, run where the user sees it. The server picks the command from the catalog
 * by the agent's id and this PC's platform; a request never carries a command. It opens a terminal
 * tab and types the command into its shell, so every line shows and Ctrl+C stops it; nothing is run
 * in the background. What was installed is read again through GET /api/agent-catalog.
 * The dispatcher in index.ts runs the access gate first: a watching device cannot reach these.
 */
import { homedir } from "node:os";
import { AGENT_CATALOG, catalogPlatform, commandProblems, type AgentCatalogEntry, type AgentTabStarted, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabClose, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";

export const INSTALL_PATH = "/api/agent-catalog/install";
export const SIGN_IN_PATH = "/api/agent-catalog/sign-in";

async function openTab(label: string, home: string): Promise<{ paneId: string; tabId: string; workspaceId: string }> {
  const snapshot = await sessionSnapshot();
  const workspace = snapshot.workspaces[0];
  const options = { cwd: home, label };
  const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
  return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id, workspaceId: created.tab.workspace_id };
}

/** How long a new Windows tab's shell has to come in front before nothing is typed there. */
const SHELL_WAIT_MS = 10_000;

/**
 * The shell running in a new pane: POSIX off Windows; on Windows the one herdr reports in front once
 * it starts, or null when herdr names neither PowerShell nor cmd.exe within `waitMs`. Nothing is
 * typed into a shell that is not known.
 */
async function shellOf(paneId: string, platform: CatalogPlatform, waitMs: number): Promise<PaneShell | null> {
  if (platform !== "windows") return "posix";
  const deadline = Date.now() + waitMs;
  for (;;) {
    const argv0 = (await paneProcessInfo(paneId))?.foreground_processes?.[0]?.argv?.[0];
    const shell = argv0 === undefined ? null : paneShell(argv0);
    if (shell !== null && shell !== "posix") return shell;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(250);
  }
}

const shellUnknown = () => conflictResponse("shell_unknown", "Ovis could not tell which shell the new tab runs, so it typed nothing there");

/** The fields each route takes; any other field is refused, so a request cannot carry a command or a platform. */
const FIELDS: Record<string, readonly string[]> = { [INSTALL_PATH]: ["agent", "alternative"], [SIGN_IN_PATH]: ["agent"] };

/** An install this PC has started and not yet seen end: its tab's pane once it has one. */
type Running = { paneId: string | null; installedBefore: boolean };

/** Types `text` into the pane's shell and runs it: a newline on POSIX, the Enter key on Windows (see shell-agent.ts). */
async function typeAndRun(paneId: string, text: string, shell: PaneShell): Promise<void> {
  if (shell === "posix") {
    await paneSendText(paneId, `${text}\n`);
    return;
  }
  await paneSendText(paneId, text);
  await paneSendKeys(paneId, ["Enter"]);
}

export class AgentInstaller {
  constructor(
    private readonly detector: AgentDetector,
    private readonly platform: CatalogPlatform | null = catalogPlatform(process.platform),
    private readonly home: string = homedir(),
    private readonly options: { shellWaitMs?: number } = {},
  ) {}

  /** The new tab's shell, or null, closing the tab, when nothing may be typed there. */
  async #shellOrClose(tabId: string, paneId: string, platform: CatalogPlatform): Promise<PaneShell | null> {
    const shell = await shellOf(paneId, platform, this.options.shellWaitMs ?? SHELL_WAIT_MS);
    if (shell === null) await tabClose(tabId);
    return shell;
  }

  async handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname !== INSTALL_PATH && pathname !== SIGN_IN_PATH) return null;
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const extra = Object.keys(body).filter((field) => !FIELDS[pathname]!.includes(field));
    if (extra.length > 0) return badRequest("unknown_field", `This route does not take ${extra.join(", ")}`);
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === body["agent"]);
    if (!entry) return badRequest("unknown_agent", "Name an agent from GET /api/agent-catalog");
    if (this.platform === null) return conflictResponse("platform_unsupported", "Ovis has no install commands for this operating system");
    try {
      return pathname === INSTALL_PATH ? await this.#install(entry, this.platform, body) : await this.#signIn(entry, this.platform);
    } catch (error) {
      return errorResponse(error);
    }
  }

  /** by agent id: the install of that agent started on this PC, one at a time */
  readonly #running = new Map<string, Running>();

  async #found(entry: AgentCatalogEntry, platform: CatalogPlatform): Promise<boolean> {
    for (const binary of entry.detect.binaries) {
      if (await this.detector.executable(binary, entry.detect.install_dirs?.[platform] ?? [], platform) !== null) return true;
    }
    return false;
  }

  /**
   * Whether an earlier install of the agent still runs: until its tab ends, or until the agent is
   * found where it was not before. An agent that was already there is held until its tab ends.
   */
  async #stillRunning(entry: AgentCatalogEntry, platform: CatalogPlatform, running: Running): Promise<boolean> {
    if (running.paneId === null) return true;
    const paneId = running.paneId;
    if (!(await sessionSnapshot()).panes.some((pane) => pane.pane_id === paneId)) return false;
    return running.installedBefore || !(await this.#found(entry, platform));
  }

  async #install(entry: AgentCatalogEntry, platform: CatalogPlatform, body: Record<string, unknown>): Promise<Response> {
    const install = entry.install[platform];
    if (install === null) return conflictResponse("no_install_command", entry.no_install[platform] ?? "No official install command for this operating system");
    const index = body["alternative"];
    if (index !== undefined && !(Number.isInteger(index) && (index as number) >= 0 && (index as number) < install.alternatives.length)) {
      return badRequest("invalid_alternative", "alternative is the index of one of the platform's alternatives");
    }
    const method = index === undefined ? install.primary : install.alternatives[index as number]!;
    // the catalog's own check again, right before the text is typed: a command that fails it never runs
    if (commandProblems(entry).length > 0) return conflictResponse("command_refused", "This install command is not one of the vendor's own; it was not run");
    const held = this.#running.get(entry.id);
    // checked again after the wait: two requests that both saw an ended install do not both start one
    if (held !== undefined && (await this.#stillRunning(entry, platform, held) || this.#running.get(entry.id) !== held)) {
      return conflictResponse("install_running", `${entry.name} is already being installed on this PC. Wait for its tab to finish, or close it.`);
    }
    const running: Running = { paneId: null, installedBefore: false };
    this.#running.set(entry.id, running);
    let started = false;
    try {
      running.installedBefore = await this.#found(entry, platform);
      const { paneId, tabId, workspaceId } = await openTab(`Install ${entry.name}`, this.home);
      running.paneId = paneId;
      const shell = await this.#shellOrClose(tabId, paneId, platform);
      if (shell === null) return shellUnknown();
      if (shell !== method.shell) {
        await tabClose(tabId);
        return conflictResponse("shell_mismatch", `This command is for ${method.shell}; the new tab runs ${shell}. Choose the other command.`);
      }
      await typeAndRun(paneId, method.command, shell);
      started = true;
      return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command: method.command, shell } satisfies AgentTabStarted);
    } finally {
      if (!started && this.#running.get(entry.id) === running) this.#running.delete(entry.id);
    }
  }

  async #signIn(entry: AgentCatalogEntry, platform: CatalogPlatform): Promise<Response> {
    if (entry.sign_in === null) return conflictResponse("no_sign_in", `${entry.name} needs no sign-in`);
    const [binary, ...args] = entry.sign_in.command ?? [entry.detect.binaries[0]!];
    const dirs = entry.detect.install_dirs?.[platform] ?? [];
    const executable = await this.detector.executable(binary!, dirs, platform);
    if (executable === null) return conflictResponse("not_installed", `${entry.name} is not installed on this PC`);
    const { paneId, tabId, workspaceId } = await openTab(`Sign in to ${entry.name}`, this.home);
    const shell = await this.#shellOrClose(tabId, paneId, platform);
    if (shell === null) return shellUnknown();
    const command = shellCommandLine(shell, executable, args);
    await typeAndRun(paneId, command, shell);
    return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command, shell } satisfies AgentTabStarted);
  }
}
