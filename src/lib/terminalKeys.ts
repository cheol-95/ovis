/**
 * The terminal's key bar on a touch screen in Input line mode: folded under the input line until
 * its Terminal keys button opens it (TerminalInput.tsx), so the grid keeps the bar's row. Whether
 * it is open is one device's choice for every pane, kept across reloads; nothing goes to the
 * server. Direct typing keeps the bar open whatever is stored here: it is that mode's only row.
 */

import { useSyncExternalStore } from "react";

/**
 * Kept in a key of its own, as the PC fold state is (`ovis:pc-collapsed:<id>`), never in
 * ovis:settings: a tab still on an older version rewrites that record whole and would erase a field
 * it does not know (docs/development.md, Stored-format changes).
 */
export const TERMINAL_KEYS_OPEN_KEY = "ovis:terminal-keys-open";

const listeners = new Set<() => void>();
// where storage refuses the write (a full or blocked one), the choice lasts for this page
let unsaved: boolean | null = null;

/** Whether the key bar is open under the input line; folded unless this device opened it. */
export function readTerminalKeysOpen(): boolean {
  if (unsaved !== null) return unsaved;
  try { return window.localStorage.getItem(TERMINAL_KEYS_OPEN_KEY) === "1"; } catch { return false; }
}

export function setTerminalKeysOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(TERMINAL_KEYS_OPEN_KEY, "1");
    else window.localStorage.removeItem(TERMINAL_KEYS_OPEN_KEY);
    unsaved = null;
  } catch {
    unsaved = open;
  }
  for (const listener of listeners) listener();
}

export function subscribeTerminalKeysOpen(listener: () => void): () => void {
  listeners.add(listener);
  // another tab of this browser opens or folds the bar: this one follows
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== TERMINAL_KEYS_OPEN_KEY && event.key !== null) return;
    unsaved = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** Whether this device keeps the key bar open under the input line, current across its tabs. */
export function useTerminalKeysOpen(): boolean {
  return useSyncExternalStore(subscribeTerminalKeysOpen, readTerminalKeysOpen, () => false);
}
