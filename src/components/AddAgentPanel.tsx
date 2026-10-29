import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ApiError, fetchAgentCatalog } from "../lib/api.ts";
import { addableAgents } from "../lib/agentList.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSetupCard } from "./AgentSetupCard.tsx";
import "./AddAgentPanel.css";

export interface AddAgentPanelProps {
  /** the agent is installed (and signed in, or that was skipped): the picker takes it */
  onReady: (agent: string) => void;
  /** shows the tab an install or sign-in runs in, which leaves the dialog */
  onOpenTerminal: (paneId: string) => void;
  /** back to the dialog's own fields, with nothing picked */
  onBack: () => void;
}

/**
 * A creation dialog's Add another agent: the agents the PC open in it does not have yet and could
 * start once installed, then the chosen one's AgentSetupCard. Leaving it at any point keeps what
 * the dialog had: nothing here is a step the user must finish.
 */
export function AddAgentPanel({ onReady, onOpenTerminal, onBack }: AddAgentPanelProps) {
  const t = useT();
  const machineId = useMachineId();
  const [agents, setAgents] = useState<AgentCatalogRow[] | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const [chosen, setChosen] = useState<AgentCatalogRow | null>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetchAgentCatalog(machineId, abort.signal).then(
      (catalog) => setAgents(addableAgents(catalog.agents)),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        // a PC on an Ovis from before the catalog answers 404 for it
        setError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    );
    return () => abort.abort();
  }, [machineId, t]);

  useEffect(() => {
    if (chosen === null) first.current?.focus();
  }, [chosen, agents]);

  if (chosen !== null) {
    return (
      <div className="add-agent">
        <AgentSetupCard agent={chosen} machineId={machineId} onOpenTerminal={onOpenTerminal} onStart={() => onReady(chosen.id)} />
        <div className="add-agent-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setChosen(null)}><ArrowLeft aria-hidden="true" />{t("Other agents")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="add-agent">
      <p className="add-agent-lead">{t("Pick an agent to install. You can go back at any time and use the ones you have.")}</p>
      {error !== null ? (
        <p className="field-hint add-agent-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>
      ) : agents === null ? (
        <p className="field-hint" role="status">{t("Loading…")}</p>
      ) : agents.length === 0 ? (
        <p className="field-hint" role="status">{t("Every agent Ovis can install here is already on this PC.")}</p>
      ) : (
        <ul className="add-agent-list" aria-label={t("Agents you can install")}>
          {agents.map((agent, index) => (
            <li key={agent.id}>
              <button type="button" ref={index === 0 ? first : undefined} className="add-agent-row" onClick={() => setChosen(agent)}>
                <AgentMark agent={agent.id} size={20} />
                <span className="add-agent-copy">
                  <span className="add-agent-name">{agent.name}</span>
                  <span className="add-agent-description">{agent.description}</span>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="add-agent-actions">
        <button type="button" ref={agents !== null && agents.length > 0 ? undefined : first} className="btn btn-ghost" onClick={onBack}><ArrowLeft aria-hidden="true" />{t("Back")}</button>
      </div>
    </div>
  );
}
