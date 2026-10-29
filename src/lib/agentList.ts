import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import type { SetupStep } from "./agentSetup.ts";

/**
 * Settings' two lists of a PC's catalog, in the catalog's order: what it has, and the rest. A PC
 * that cannot tell (`installed: null`) lists the agent as one it can install: it never claims one.
 */
export function agentSections(rows: readonly AgentCatalogRow[]): { installed: AgentCatalogRow[]; available: AgentCatalogRow[] } {
  return {
    installed: rows.filter((row) => row.state.installed === true),
    available: rows.filter((row) => row.state.installed !== true),
  };
}

/**
 * What a picker's Add another agent offers: an agent the picker can start once it is there, that
 * the PC surely lacks, with an install command for that PC.
 */
export function addableAgents(rows: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return rows.filter((row) => row.state.installed === false && row.install !== null && pickerStarts(row.id));
}

/** Whether New workspace's picker can start the agent once the PC lists it; the catalog has more (Command Code). */
export function pickerStarts(agent: string): boolean {
  return SUPPORTED_AGENT_KINDS.has(agent);
}

/**
 * Where AgentSetupCard starts for an agent as the PC answered it: an installed one at its sign-in
 * (or ready, when it needs none), so a sign-in left for a terminal tab can be finished later.
 */
export function setupStart(row: AgentCatalogRow): SetupStep {
  if (row.state.installed !== true) return { kind: "idle" };
  return row.sign_in === null ? { kind: "ready", version: row.state.version } : { kind: "installed", version: row.state.version, onPath: row.state.on_path !== false };
}
