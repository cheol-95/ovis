import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, KeyRound, RotateCw } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ApiError, fetchAgentCatalog } from "../lib/api.ts";
import { agentSections, pickerStarts, setupStart } from "../lib/agentList.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSetupCard } from "./AgentSetupCard.tsx";
import { SettingsGroup } from "./SettingsControls.tsx";
import "./AgentCatalogSettings.css";

export interface AgentCatalogSettingsProps {
  /** a watching device may read the list, but an install is a change it cannot make */
  watching: boolean;
  /** shows a pane of `machineId` in its terminal: the tab an install or sign-in runs in */
  onOpenPane: (machineId: string, paneId: string) => void;
  /** the agent is ready and a picker can start it: New workspace on `machineId`, with it picked */
  onStartAgent: (machineId: string, agent: string) => void;
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
  // the PC the setup began on: it stays that PC's, whatever PC is picked meanwhile
  const [setup, setSetup] = useState<{ row: AgentCatalogRow; machineId: string } | null>(null);
  const setupView = useRef<HTMLElement>(null);
  useEffect(() => { if (setup !== null) setupView.current?.focus(); }, [setup]);
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
    const back = (): void => { setSetup(null); setReads((count) => count + 1); };
    const { row, machineId: on } = setup;
    return (
      <section ref={setupView} className="settings-section settings-agent-setup" tabIndex={-1} aria-label={t("Set up {agent}", { agent: row.name })}>
        {/* an agent no picker starts (Command Code) is done here: it runs from a terminal tab */}
        <AgentSetupCard agent={row} machineId={on} initial={setupStart(row)} onOpenTerminal={(paneId) => onOpenPane(on, paneId)} onStart={() => { if (pickerStarts(row.id)) onStartAgent(on, row.id); else back(); }} />
        <div>
          <button type="button" className="btn btn-ghost settings-agent-back" onClick={back}><ArrowLeft aria-hidden="true" />{t("All agents")}</button>
        </div>
      </section>
    );
  }

  const shown = rows !== null && rows.machineId === machineId ? rows.agents : null;
  const toolbar = (
    <div className="settings-agent-toolbar">
      <button type="button" className="btn btn-ghost" onClick={() => setReads((count) => count + 1)}><RotateCw aria-hidden="true" />{t("Check again")}</button>
    </div>
  );
  if (error !== null) return <><SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p></SettingsGroup>{toolbar}</>;
  if (shown === null) return <SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  const { installed, available } = agentSections(shown);
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
            {/* a sign-in left for its terminal tab is finished here, on the card's sign-in step */}
            {!watching && agent.sign_in !== null && <button type="button" className="btn btn-ghost settings-agent-install" aria-label={t("Sign in to {agent}", { agent: agent.name })} onClick={() => setSetup({ row: agent, machineId })}><KeyRound aria-hidden="true" />{t("Sign in")}</button>}
          </AgentRow>
        ))}
      </SettingsGroup>
      {available.length > 0 && <SettingsGroup title={t("Can be installed")} section="agents-available">
        {available.map((agent) => (
          <AgentRow key={agent.id} agent={agent} detail={agent.install === null
            ? agent.no_install !== null && <span className="settings-condition">{agent.no_install}</span>
            : agent.state.installed === null && <span className="settings-condition">{t("Ovis cannot tell whether it is on this PC.")}</span>}>
            {!watching && <button type="button" className="btn settings-agent-install" disabled={agent.install === null} aria-label={t("Install {agent}", { agent: agent.name })} onClick={() => setSetup({ row: agent, machineId })}><Download aria-hidden="true" />{t("Install")}</button>}
          </AgentRow>
        ))}
      </SettingsGroup>}
    </>
  );
}
