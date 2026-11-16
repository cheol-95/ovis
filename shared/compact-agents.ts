/** Opt-in wire representation; application state and legacy/bridge responses keep full agents. */
import type { AgentInfo, PaneInfo, SessionSnapshot } from "./protocol.ts";
import type { Machine, MachineEvent } from "./machines.ts";

// Fixed v1 contract: adding inherited fields requires a new negotiation/version, for cached clients.
const SHARED_FIELDS = [
  "terminal_id", "agent", "terminal_title", "terminal_title_stripped", "agent_status", "agent_session",
  "workspace_id", "tab_id", "focused", "cwd", "foreground_cwd", "revision", "title", "display_agent", "tokens", "state_labels",
] as const satisfies readonly (keyof AgentInfo & keyof PaneInfo)[];
type SharedField = typeof SHARED_FIELDS[number];
type AgentRef = Partial<AgentInfo> & Pick<AgentInfo, "pane_id"> & { _omit?: SharedField[] };
export type CompactSnapshot = Omit<SessionSnapshot, "agents"> & { agent_refs: AgentRef[] };
export type WireMachine = Omit<Machine, "snapshot"> & { snapshot: SessionSnapshot | CompactSnapshot | null };
type SnapshotEvent = Extract<MachineEvent, { type: "machine-message" }>;
export type WireMachineEvent = MachineEvent
  | { type: "machines"; machines: WireMachine[] }
  | (Omit<SnapshotEvent, "message"> & { message: Omit<Extract<SnapshotEvent["message"], { type: "snapshot" }>, "snapshot"> & { snapshot: SessionSnapshot | CompactSnapshot } });

/** `agent_refs` is this server's marker alone: one a PC put in its own snapshot is removed before any wire form. */
function fullSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  if (!Object.hasOwn(snapshot, "agent_refs")) return snapshot;
  const { agent_refs: _foreign, ...full } = snapshot as SessionSnapshot & { agent_refs?: unknown };
  return full;
}

/** Only equal values are inherited. Conflicts, agent-only fields, array order and absent fields survive. */
export function compactSnapshot(received: SessionSnapshot): SessionSnapshot | CompactSnapshot {
  const snapshot = fullSnapshot(received);
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  let saved = false;
  const refs = snapshot.agents.map((agent): AgentRef => {
    const pane = panes.get(agent.pane_id);
    if (!pane) return agent;
    const ref: AgentRef = { ...agent };
    const omit: SharedField[] = [];
    for (const key of SHARED_FIELDS) {
      if (!Object.hasOwn(pane, key)) continue;
      if (!Object.hasOwn(agent, key) || agent[key] === undefined) { omit.push(key); delete ref[key]; }
      else if (JSON.stringify(agent[key]) === JSON.stringify(pane[key])) { delete ref[key]; saved = true; }
    }
    if (omit.length) ref._omit = omit;
    return ref;
  });
  // The longer wire key costs four characters. Do not grow sparse agent rows with omission metadata.
  if (!saved || JSON.stringify(refs).length + 4 >= JSON.stringify(snapshot.agents).length) return snapshot;
  const { agents: _agents, ...rest } = snapshot;
  return { ...rest, agent_refs: refs };
}

/** Expands only the encoder's own form, its marker without full rows: a snapshot carrying both is full. */
export function expandSnapshot(snapshot: SessionSnapshot | CompactSnapshot): SessionSnapshot {
  if (Object.hasOwn(snapshot, "agents") || !Object.hasOwn(snapshot, "agent_refs")) return fullSnapshot(snapshot as SessionSnapshot);
  const { agent_refs: refs, ...rest } = snapshot as CompactSnapshot;
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const agents = refs.map((ref): AgentInfo => {
    const { _omit: omit, ...overrides } = ref;
    const pane = panes.get(ref.pane_id);
    const inherited = Object.fromEntries(SHARED_FIELDS.filter((key) => pane && Object.hasOwn(pane, key)).map((key) => [key, pane![key]]));
    // Never inherit a value the agent did not have, including optional titles and token fields.
    for (const key of omit ?? []) if (SHARED_FIELDS.includes(key)) delete inherited[key];
    return { ...inherited, ...overrides } as AgentInfo;
  });
  return { ...rest, agents };
}

/** A machine as a client takes it: compact when it asked, and never with a PC's own marker. */
export function wireMachine(machine: Machine, compact: boolean): WireMachine {
  if (!machine.snapshot) return machine;
  return { ...machine, snapshot: compact ? compactSnapshot(machine.snapshot) : fullSnapshot(machine.snapshot) };
}

export function expandMachine(machine: WireMachine): Machine {
  return machine.snapshot ? { ...machine, snapshot: expandSnapshot(machine.snapshot) } : machine as Machine;
}

/** A machine event as a client takes it: compact when it asked, and never with a PC's own marker. */
export function wireMachineEvent(event: MachineEvent, compact: boolean): WireMachineEvent {
  if (event.type === "machines") return { ...event, machines: event.machines.map((machine) => wireMachine(machine, compact)) };
  if (event.type === "machine-message" && event.message.type === "snapshot") {
    const { snapshot } = event.message;
    return { ...event, message: { ...event.message, snapshot: compact ? compactSnapshot(snapshot) : fullSnapshot(snapshot) } };
  }
  return event;
}

export function expandMachineEvent(event: WireMachineEvent): MachineEvent {
  if (event.type === "machines") return { ...event, machines: event.machines.map(expandMachine) };
  if (event.type === "machine-message" && event.message.type === "snapshot") {
    return { ...event, message: { ...event.message, snapshot: expandSnapshot(event.message.snapshot) } };
  }
  return event as MachineEvent;
}
