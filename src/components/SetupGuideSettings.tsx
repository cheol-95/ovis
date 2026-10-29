import { useEffect, useState } from "react";
import { Check, Circle, Play } from "lucide-react";

import { fetchAgentCatalog, fetchDevices } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { notificationState } from "../lib/notifications.ts";
import { useSettings } from "../lib/settings.ts";
import { openSetupGuide } from "../lib/setupGuide.ts";
import { SettingsGroup } from "./SettingsControls.tsx";
import "./SetupGuideSettings.css";

interface StepLine { done: boolean; text: string }

function StepRow({ line, reading }: { line: StepLine | null; reading: string }) {
  return (
    <li className="settings-guide-step" data-done={line?.done || undefined}>
      {line?.done ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
      <span>{line?.text ?? reading}</span>
    </li>
  );
}

/**
 * Settings → Setup guide: where each of the first-run guide's steps stands, read from what the app
 * already knows (the PC's agents, the plan usage switch, paired devices, this device's alerts), and
 * the button that opens the guide again (lib/setupGuide.ts). Nothing here changes a setting.
 */
export function SetupGuideSettings({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const { settings } = useSettings();
  const locale = useLocale();
  const machineId = useMachineId();
  const [agents, setAgents] = useState<string[] | null | "unknown">(null);
  const [devices, setDevices] = useState<number | null | "unknown">(null);

  useEffect(() => {
    const abort = new AbortController();
    fetchAgentCatalog(machineId, abort.signal).then(
      (catalog) => setAgents(catalog.agents.filter((agent) => agent.kind === "harness" && agent.state.installed === true).map((agent) => agent.name)),
      () => { if (!abort.signal.aborted) setAgents("unknown"); },
    );
    return () => abort.abort();
  }, [machineId]);

  useEffect(() => {
    let live = true;
    // any paired device counts, the one reading this page too: a phone may be the one that opened it
    fetchDevices().then(
      (list) => { if (live) setDevices(list.length); },
      () => { if (live) setDevices("unknown"); },
    );
    return () => { live = false; };
  }, []);

  const agentLine: StepLine | null = agents === null ? null
    : agents === "unknown" ? { done: false, text: t("Agent: could not be read") }
    : agents.length === 0 ? { done: false, text: t("Agent: none yet") }
    : { done: true, text: t("Agent: {names}", { names: new Intl.ListFormat(locale, { type: "conjunction" }).format(agents) }) };
  const usageLine: StepLine = settings.showUsage ? { done: true, text: t("Plan usage: on") } : { done: false, text: t("Plan usage: off") };
  const phoneLine: StepLine | null = devices === null ? null
    : devices === "unknown" ? { done: false, text: t("Phone: could not be read") }
    : devices === 0 ? { done: false, text: t("Phone: not connected") }
    : { done: true, text: t("Phone: connected") };
  const alertsLine: StepLine = settings.alertsOn && notificationState() === "granted" ? { done: true, text: t("Alerts: on") } : { done: false, text: t("Alerts: off") };
  const reading = t("Loading…");

  return (
    <SettingsGroup note={t("The guide from your first visit. Run it again to add an agent, show plan usage, connect your phone or turn on alerts. Every step can be skipped, and nothing you already set up is undone.")}>
      <div className="settings-row settings-guide">
        <div className="settings-row-text">
          <span className="settings-label">{t("Setup guide")}</span>
          <ul className="settings-guide-steps" aria-label={t("Where each step stands")}>
            <StepRow line={agentLine} reading={reading} />
            <StepRow line={usageLine} reading={reading} />
            <StepRow line={phoneLine} reading={reading} />
            <StepRow line={alertsLine} reading={reading} />
          </ul>
        </div>
        <button type="button" className="btn settings-guide-open" onClick={() => { onOpen(); openSetupGuide(); }}><Play aria-hidden="true" />{t("Open setup guide")}</button>
      </div>
    </SettingsGroup>
  );
}
