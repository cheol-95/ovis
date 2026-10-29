/**
 * POST /api/agent-catalog/install and /api/agent-catalog/sign-in: an agent's official install
 * command, or its sign-in, run where the user sees it. The server picks the command from the catalog
 * by the agent's id and this PC's platform; a request never carries a command. It opens a terminal
 * tab and types the command into its shell, so every line shows and Ctrl+C stops it; nothing is run
 * in the background. What was installed is read again through GET /api/agent-catalog.
 * The dispatcher in index.ts runs the access gate first: a watching device cannot reach these.
 */
import { homedir } from "node:os";
import { AGENT_CATALOG, catalogPlatform, commandProblems, type AgentCatalogEntry, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";

export const INSTALL_PATH = "/api/agent-catalog/install";
export const SIGN_IN_PATH = "/api/agent-catalog/sign-in";

/** What a started install or sign-in answers: its tab, and the exact text typed there. */
export interface AgentTabStarted {
  pane_id: string;
  workspace_id: string;
  command: string;
  shell: PaneShell;
}

async function openTab(label: string, home: string): Promise<{ paneId: string; workspaceId: string }> {
  const snapshot = await sessionSnapshot();
  const workspace = snapshot.workspaces[0];
  const options = { cwd: home, label };
  const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
  return { paneId: created.root_pane.pane_id, workspaceId: created.tab.workspace_id };
}

/** The shell running in a new pane: POSIX off Windows; on Windows the one herdr reports in front. */
async function shellOf(paneId: string, platform: CatalogPlatform): Promise<PaneShell> {
  if (platform !== "windows") return "posix";
  const info = await paneProcessInfo(paneId);
  return paneShell(info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
}

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
  ) {}

  async handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname !== INSTALL_PATH && pathname !== SIGN_IN_PATH) return null;
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === body["agent"]);
    if (!entry) return badRequest("unknown_agent", "Name an agent from GET /api/agent-catalog");
    if (this.platform === null) return conflictResponse("platform_unsupported", "Ovis has no install commands for this operating system");
    try {
      return pathname === INSTALL_PATH ? await this.#install(entry, this.platform, body) : await this.#signIn(entry, this.platform);
    } catch (error) {
      return errorResponse(error);
    }
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
    const { paneId, workspaceId } = await openTab(`Install ${entry.name}`, this.home);
    const shell = await shellOf(paneId, platform);
    if (shell !== method.shell) {
      return conflictResponse("shell_mismatch", `This command is for ${method.shell}; the new tab runs ${shell}. Choose the other command.`);
    }
    await typeAndRun(paneId, method.command, shell);
    return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command: method.command, shell } satisfies AgentTabStarted);
  }

  async #signIn(entry: AgentCatalogEntry, platform: CatalogPlatform): Promise<Response> {
    if (entry.sign_in === null) return conflictResponse("no_sign_in", `${entry.name} needs no sign-in`);
    const [binary, ...args] = entry.sign_in.command ?? [entry.detect.binaries[0]!];
    const dirs = entry.detect.install_dirs?.[platform] ?? [];
    const executable = await this.detector.executable(binary!, dirs, platform);
    if (executable === null) return conflictResponse("not_installed", `${entry.name} is not installed on this PC`);
    const { paneId, workspaceId } = await openTab(`Sign in to ${entry.name}`, this.home);
    const shell = await shellOf(paneId, platform);
    const command = shellCommandLine(shell, executable, args);
    await typeAndRun(paneId, command, shell);
    return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command, shell } satisfies AgentTabStarted);
  }
}
