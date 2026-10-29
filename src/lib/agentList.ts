import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";

/** Settings → Agent integrations' filter: every agent, the coding agents, or the always-on assistants. */
export type AgentKindFilter = "all" | AgentCatalogRow["kind"];

/**
 * Settings' two lists of a PC's catalog, in the catalog's order: what it has, and the rest. A PC
 * that cannot tell (`installed: null`) lists the agent as one it can install: it never claims one.
 */
export function agentSections(rows: readonly AgentCatalogRow[], filter: AgentKindFilter): { installed: AgentCatalogRow[]; available: AgentCatalogRow[] } {
  const shown = rows.filter((row) => filter === "all" || row.kind === filter);
  return {
    installed: shown.filter((row) => row.state.installed === true),
    available: shown.filter((row) => row.state.installed !== true),
  };
}

/**
 * What a picker's Add another agent offers: an agent the picker can start once it is there, that
 * the PC surely lacks, with an install command for that PC.
 */
export function addableAgents(rows: readonly AgentCatalogRow[]): AgentCatalogRow[] {
  return rows.filter((row) => row.state.installed === false && row.install !== null && SUPPORTED_AGENT_KINDS.has(row.id));
}
