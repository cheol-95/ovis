import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Download, RotateCw } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ApiError, fetchAgentCatalog } from "../lib/api.ts";
import { agentSections, type AgentKindFilter } from "../lib/agentList.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSetupCard } from "./AgentSetupCard.tsx";
import { Segmented, SettingsGroup } from "./SettingsControls.tsx";
import "./AgentCatalogSettings.css";

export interface AgentCatalogSettingsProps {
  /** a watching device may read the list, but an install is a change it cannot make */
  watching: boolean;
  /** shows a pane of `machineId` in its terminal: the tab an install or sign-in runs in */
  onOpenPane: (machineId: string, paneId: string) => void;
  /** the agent is ready: a new workspace with it */
  onStartAgent: (agent: string) => void;
}

function AgentRow({ agent, detail, children }: { agent: AgentCatalogRow; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row settings-agent-row">
      <AgentMark agent={agent.id} size={22} />
      <div className="settings-row-text">
        <span className="settings-label">{agent.name}</span>
        <span className="settings-description">{agent.description}{detail}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Settings → Agent integrations' own list of the PC open here: every agent Ovis can install, what
 * that PC has (with the version it answered) and the rest, each with Install, which opens the same
 * AgentSetupCard as the creation dialogs' Add another agent.
 */
export function AgentCatalogSettings({ watching, onOpenPane, onStartAgent }: AgentCatalogSettingsProps) {
  const t = useT();
  const machineId = useMachineId();
  const [rows, setRows] = useState<{ machineId: string; agents: AgentCatalogRow[] } | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const [filter, setFilter] = useState<AgentKindFilter>("all");
  const [setup, setSetup] = useState<AgentCatalogRow | null>(null);
  // each Check again, and each return from a setup, reads the PC again
  const [reads, setReads] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    fetchAgentCatalog(machineId, abort.signal).then(
      (catalog) => setRows({ machineId, agents: catalog.agents }),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        // a PC on an Ovis from before the catalog answers 404 for it
        setError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    );
    return () => abort.abort();
  }, [machineId, reads, t]);

  const note = t("Install runs the maker's own installer in a terminal tab on this PC, where you can watch it.");
  if (setup !== null) {
    return (
      <section className="settings-section settings-agent-setup">
        <AgentSetupCard agent={setup} machineId={machineId} onOpenTerminal={(paneId) => onOpenPane(machineId, paneId)} onStart={() => onStartAgent(setup.id)} />
        <div>
          <button type="button" className="btn btn-ghost settings-agent-back" onClick={() => { setSetup(null); setReads((count) => count + 1); }}><ArrowLeft aria-hidden="true" />{t("All agents")}</button>
        </div>
      </section>
    );
  }

  const shown = rows !== null && rows.machineId === machineId ? rows.agents : null;
  const toolbar = (
    <div className="settings-agent-toolbar">
      <Segmented label={t("Show")} value={filter} onChange={setFilter} options={[{ value: "all", label: t("All") }, { value: "harness", label: t("Coding agents") }, { value: "assistant", label: t("Assistants") }]} />
      <button type="button" className="btn btn-ghost" onClick={() => setReads((count) => count + 1)}><RotateCw aria-hidden="true" />{t("Check again")}</button>
    </div>
  );
  if (error !== null) return <SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p></SettingsGroup>;
  if (shown === null) return <SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  const { installed, available } = agentSections(shown, filter);
  return (
    <>
      <section className="settings-section">
        <h3>{t("Agents")}</h3>
        <p className="settings-description settings-note">{note}</p>
        {toolbar}
      </section>
      <SettingsGroup title={t("Installed")} section="agents-installed">
        {installed.length === 0 ? <p className="settings-item settings-hint">{t("None on this PC yet.")}</p> : installed.map((agent) => (
          <AgentRow key={agent.id} agent={agent} detail={agent.state.meets_min_version === false && agent.min_version !== null && <span className="settings-condition">{t("Ovis needs {version} or later.", { version: agent.min_version.version })}</span>}>
            <span className="settings-agent-version">{agent.state.version ?? t("Installed")}</span>
          </AgentRow>
        ))}
      </SettingsGroup>
      {available.length > 0 && <SettingsGroup title={t("Can be installed")} section="agents-available">
        {available.map((agent) => (
          <AgentRow key={agent.id} agent={agent} detail={agent.install === null
            ? agent.no_install !== null && <span className="settings-condition">{agent.no_install}</span>
            : agent.state.installed === null && <span className="settings-condition">{t("Ovis cannot tell whether it is on this PC.")}</span>}>
            {!watching && <button type="button" className="btn settings-agent-install" disabled={agent.install === null} aria-label={t("Install {agent}", { agent: agent.name })} onClick={() => setSetup(agent)}><Download aria-hidden="true" />{t("Install")}</button>}
          </AgentRow>
        ))}
      </SettingsGroup>}
    </>
  );
}
