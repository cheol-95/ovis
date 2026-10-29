import { useEffect, useState } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { conversationSearchOffered } from "./api.ts";

const probes = new Map<string, Promise<boolean>>();

/**
 * Whether a PC's bridge searches a conversation's older pages (GET /api/pane/conversation/search):
 * this PC's does; another PC's is asked once while it is online, and again once it has been away
 * (its bridge may have been updated meanwhile). The chat's search is offered only where it is.
 */
export function useConversationSearchOffered(machineId: string, online: boolean): boolean {
  const [offered, setOffered] = useState<{ machineId: string; answer: boolean } | null>(null);
  useEffect(() => {
    if (machineId === LOCAL_MACHINE) return;
    if (!online) { probes.delete(machineId); return; }
    let live = true;
    let probe = probes.get(machineId);
    if (probe === undefined) {
      probe = conversationSearchOffered(machineId);
      probes.set(machineId, probe);
      const asked = probe;
      asked.catch(() => { if (probes.get(machineId) === asked) probes.delete(machineId); });
    }
    probe.then((answer) => { if (live) setOffered({ machineId, answer }); }, () => { /* asked again when it is back */ });
    return () => { live = false; };
  }, [machineId, online]);
  if (machineId === LOCAL_MACHINE) return true;
  return online && offered?.machineId === machineId && offered.answer;
}
