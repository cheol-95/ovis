import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import { addableAgents, agentSections, setupStart } from "./agentList.ts";

const missing: AgentInstallState = { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
const found = (version: string): AgentInstallState => ({ installed: true, binary: "/usr/bin/x", on_path: true, version, version_error: null, meets_min_version: true });
const unknown: AgentInstallState = { ...missing, installed: null };
const row = (id: string, state: AgentInstallState = missing) => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", state);

describe("agentSections", () => {
  const rows = [row("claude", found("2.1.312")), row("codex"), row("hermes"), row("opencode", unknown)];

  it("puts what the PC has under Installed and the rest under Can be installed, in the catalog's order", () => {
    const { installed, available } = agentSections(rows, "all");
    expect(installed.map((agent) => agent.id)).toEqual(["claude"]);
    // a PC that cannot tell offers the install rather than claim the agent is there
    expect(available.map((agent) => agent.id)).toEqual(["codex", "hermes", "opencode"]);
  });

  it("keeps coding agents and assistants apart when filtered", () => {
    expect(agentSections(rows, "assistant")).toEqual({ installed: [], available: [rows[2]!] });
    expect(agentSections(rows, "harness").available.map((agent) => agent.id)).toEqual(["codex", "opencode"]);
  });
});

describe("addableAgents", () => {
  it("offers only agents a picker can start, that the PC lacks and has a command for", () => {
    const rows = [row("claude", found("2.1.312")), row("codex"), row("muse"), row("opencode", unknown), row("hermes")];
    // claude is there, muse has no install command, opencode cannot be told apart on this PC
    expect(addableAgents(rows).map((agent) => agent.id)).toEqual(["codex", "hermes"]);
  });

  it("leaves out a catalog agent the pickers cannot start", () => {
    const commandCode = AGENT_CATALOG.find((entry) => entry.id === "cmd");
    if (commandCode === undefined) throw new Error("the catalog has no cmd entry");
    expect(addableAgents([catalogRow(commandCode, "linux", missing)])).toEqual([]);
  });
});

describe("setupStart", () => {
  it("starts an installed agent at its sign-in, one that needs none ready, and the rest at Install", () => {
    expect(setupStart(row("codex", found("0.163.0")))).toEqual({ kind: "installed", version: "0.163.0", onPath: true });
    expect(setupStart(row("codex"))).toEqual({ kind: "idle" });
    expect(setupStart(row("opencode", unknown))).toEqual({ kind: "idle" });
    expect(setupStart({ ...row("codex", found("1.0.0")), sign_in: null })).toEqual({ kind: "ready", version: "1.0.0" });
  });
});
