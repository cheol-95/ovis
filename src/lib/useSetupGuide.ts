import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPreferences } from "./api.ts";
import { onSetupGuideRequest } from "./setupGuide.ts";
import { autoOpen, GUIDE_STORAGE_KEY, guideStep, readGuide, REOPENED, saveGuide, WELCOME, type GuideEvent, type GuideState } from "./setupGuideFlow.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

const storage = (): Storage | null => {
  try { return window.localStorage; } catch { return null; }
};

export interface SetupGuideFacts {
  /** the app is in (past the access gate) */
  enabled: boolean;
  /** this PC's workspaces once the roster has them; null before */
  workspaces: number | null;
  /** undefined until the server's access facts and this device's role are both known; null when it sent none */
  pairingGate: "open" | "closed" | "unavailable" | null | undefined;
  watching: boolean;
  /** the pane in front, and whether the app picked it by itself rather than the user */
  selection: { machineId: string; paneId: string | null; auto: boolean };
}

/**
 * The setup guide's place in the app: shown by itself once on a fresh install (lib/setupGuideFlow.ts),
 * resumed where a reload left it, and opened again by Settings → Setup guide (lib/setupGuide.ts).
 * `paused`: it steps aside, still mounted, for a pane the user went to (a row, the palette, a new
 * workspace, a notification, the tab it opened itself); a pane the app picks by itself leaves it in front.
 */
export function useSetupGuide({ enabled, workspaces, pairingGate, watching, selection }: SetupGuideFacts) {
  // read before this page saves anything: a save made by the guide itself must not count
  const [savedSettings] = useState(() => { try { return storage()?.getItem(SETTINGS_STORAGE_KEY) != null; } catch { return true; } });
  const [record] = useState(() => { const store = storage(); return store === null ? null : readGuide(store); });
  const [guide, setGuide] = useState<GuideState | null>(() => record?.status === "open" ? record.state : null);
  const [paused, setPaused] = useState(false);
  const [sharedRevision, setSharedRevision] = useState<number | null>(null);
  const decided = useRef(record !== null);

  useEffect(() => {
    if (!enabled || decided.current) return;
    // no answer, or a server without shared settings, is not proof of a fresh install
    fetchPreferences().then((preferences) => setSharedRevision(preferences?.revision ?? -1), () => setSharedRevision(-1));
  }, [enabled]);

  useEffect(() => {
    if (decided.current || !enabled || pairingGate === undefined) return;
    if (workspaces === null || sharedRevision === null) return;
    decided.current = true;
    if (autoOpen({ workspaces, savedSettings, sharedRevision, pairingGate, watching })) setGuide(WELCOME);
  }, [enabled, workspaces, sharedRevision, pairingGate, watching, savedSettings]);

  useEffect(() => {
    const reopen = () => { decided.current = true; setGuide(REOPENED); setPaused(false); };
    // closed in another tab of this browser: closed here too, so this tab's next step cannot reopen it
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== GUIDE_STORAGE_KEY || event.newValue === null) return;
      const store = storage();
      if (store !== null && readGuide(store)?.status === "closed") { decided.current = true; setGuide(null); setPaused(false); }
    };
    window.addEventListener("storage", onStorage);
    const stop = onSetupGuideRequest(reopen);
    return () => { stop(); window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    const store = storage();
    if (guide !== null && store !== null) saveGuide(store, guide);
  }, [guide]);

  const open = guide !== null;
  const shownSelection = useRef(selection);
  useEffect(() => {
    const before = shownSelection.current;
    shownSelection.current = selection;
    if (before.machineId === selection.machineId && before.paneId === selection.paneId) return;
    if (open && selection.paneId !== null && !selection.auto) setPaused(true);
  }, [selection.machineId, selection.paneId, selection.auto]); // eslint-disable-line react-hooks/exhaustive-deps

  const dispatch = useCallback((event: GuideEvent) => setGuide((current) => current === null ? null : guideStep(current, event)), []);
  const close = useCallback(() => {
    setGuide(null);
    setPaused(false);
    const store = storage();
    if (store !== null) saveGuide(store, null);
  }, []);
  const resume = useCallback(() => setPaused(false), []);
  return { guide, paused, dispatch, close, resume };
}
