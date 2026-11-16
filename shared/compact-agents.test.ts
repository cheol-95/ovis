import { describe, expect, it } from "bun:test";
import type { AgentInfo, HerdrPane, SessionSnapshot } from "./protocol.ts";
import type { MachineEvent } from "./machines.ts";
import { compactMachineEvent, compactSnapshot, expandMachineEvent, expandSnapshot } from "./compact-agents.ts";

function snapshot(): SessionSnapshot {
  const pane: HerdrPane = {
    pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: true,
    agent: "codex", agent_status: "working", cwd: "/work/project", foreground_cwd: "/work/project",
    terminal_title: "An agent working on the project", terminal_title_stripped: "An agent working on the project",
    agent_session: { agent: "codex", source: "test", kind: "id", value: "session-1" }, revision: 5, context: { used: 50, window: 100 },
  };
  const { context: _context, ...common } = pane;
  const agent: AgentInfo = { ...common, state_change_seq: 42, completion_seq: 11, interactive_ready: true };
  return { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [pane], layouts: [], agents: [agent] };
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("opt-in agent references", () => {
  it("reuses pane fields and restores agent-only values without changing the source snapshot", () => {
    const original = snapshot();
    const before = wire(original);
    const compact = compactSnapshot(original);
    expect("agent_refs" in compact).toBe(true);
    if (!("agent_refs" in compact)) throw new Error("expected references");
    expect(compact.agent_refs).toEqual([{ pane_id: "w1:p1", state_change_seq: 42, completion_seq: 11, interactive_ready: true }]);
    expect(expandSnapshot(wire(compact))).toEqual(original);
    expect(original).toEqual(before);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length);
  });

  it("preserves differing values, nulls, absent optional fields, nested values and agent order", () => {
    const original = snapshot();
    original.panes[0]!.title = "pane title";
    original.panes[0]!.tokens = { role: "private-pane" };
    original.agents[0] = { ...original.agents[0]!, cwd: null, foreground_cwd: "/other", focused: false, tokens: { role: "agent" } };
    original.agents.unshift({ ...original.agents[0]!, pane_id: "orphan", title: "not listed in panes" });
    const decoded = expandSnapshot(wire(compactSnapshot(original)));
    expect(decoded).toEqual(original);
    expect(Object.hasOwn(decoded.agents[1]!, "title")).toBe(false);
    expect(decoded.agents[1]!.tokens).toEqual({ role: "agent" });
    expect(decoded.agents.map((agent) => agent.pane_id)).toEqual(["orphan", "w1:p1"]);
    delete original.agents[1]!.tokens;
    const withoutTokens = expandSnapshot(wire(compactSnapshot(original)));
    expect(Object.hasOwn(withoutTokens.agents[1]!, "tokens")).toBe(false);
    expect(withoutTokens).toEqual(original);
  });

  it("keeps literal agents when their panes are absent and accepts legacy snapshots unchanged", () => {
    const original = snapshot(); original.panes = [];
    expect(compactSnapshot(original)).toBe(original);
    expect(expandSnapshot(original)).toBe(original);
  });

  it("keeps sparse full rows when omission metadata would make their wire representation larger", () => {
    const original = snapshot();
    original.agents = [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w", tab_id: "t", focused: true, agent_status: "idle", revision: 0 }];
    expect(compactSnapshot(original)).toBe(original);
  });

  it("reconstructs optional fields after JSON has omitted undefined values", () => {
    const original = snapshot();
    original.panes[0]!.title = "pane only";
    original.agents[0]!.title = undefined;
    expect(wire(expandSnapshot(wire(compactSnapshot(original))))).toEqual(wire(original));
  });

  it("handles both roster and pushed snapshot events and leaves unrelated events alone", () => {
    const original = snapshot();
    const events: MachineEvent[] = [
      { type: "machines", machines: [
        { id: "local", name: "PC", kind: "local", enabled: true, state: "connected", error: null, snapshot: original },
        { id: "remote", name: "Away", kind: "ssh", enabled: false, state: "disconnected", error: null, snapshot: null },
      ] },
      { type: "machine-message", machine_id: "remote", message: { type: "snapshot", snapshot: original, connection: "connection", features: [] } },
    ];
    for (const event of events) expect(expandMachineEvent(wire(compactMachineEvent(event)))).toEqual(event);
    const seen: MachineEvent = { type: "seen", finishes: [] };
    expect(compactMachineEvent(seen)).toBe(seen);
    expect(expandMachineEvent(seen)).toBe(seen);
  });
});
