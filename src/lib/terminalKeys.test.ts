import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { readTerminalKeysOpen, setTerminalKeysOpen, subscribeTerminalKeysOpen, TERMINAL_KEYS_OPEN_KEY } from "./terminalKeys.ts";
import { DEFAULT_SETTINGS, saveSettings } from "./settings.ts";

describe("the key bar folded under the input line", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let records: Map<string, string>;
  let storageListeners: Array<(event: { key: string | null }) => void> = [];
  let failWrites = false;
  beforeEach(() => {
    records = new Map();
    storageListeners = [];
    failWrites = false;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); records.set(key, value); },
        removeItem: (key: string) => { if (failWrites) throw new Error("blocked"); records.delete(key); },
      },
      addEventListener: (type: string, listener: (event: { key: string | null }) => void) => { if (type === "storage") storageListeners.push(listener); },
      removeEventListener: () => undefined,
    } });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("starts folded, and a device that opened it finds it open after a reload", () => {
    expect(readTerminalKeysOpen()).toBe(false);
    setTerminalKeysOpen(true);
    expect(records.get(TERMINAL_KEYS_OPEN_KEY)).toBe("1");
    expect(readTerminalKeysOpen()).toBe(true);
    setTerminalKeysOpen(false);
    expect(records.has(TERMINAL_KEYS_OPEN_KEY)).toBe(false);
    expect(readTerminalKeysOpen()).toBe(false);
  });

  it("lives in its own key, so a whole-record save of ovis:settings cannot fold it", () => {
    setTerminalKeysOpen(true);
    saveSettings(DEFAULT_SETTINGS);
    expect(readTerminalKeysOpen()).toBe(true);
  });

  it("reads anything but the stored open mark as folded", () => {
    records.set(TERMINAL_KEYS_OPEN_KEY, "true");
    expect(readTerminalKeysOpen()).toBe(false);
  });

  it("keeps a choice storage refused for this page, until another tab changes it", () => {
    const changes: number[] = [];
    const unsubscribe = subscribeTerminalKeysOpen(() => changes.push(1));
    failWrites = true;
    setTerminalKeysOpen(true);
    expect(readTerminalKeysOpen()).toBe(true);
    records.delete(TERMINAL_KEYS_OPEN_KEY);
    for (const listener of storageListeners) listener({ key: TERMINAL_KEYS_OPEN_KEY });
    expect(readTerminalKeysOpen()).toBe(false);
    for (const listener of storageListeners) listener({ key: "ovis:settings" });
    expect(changes.length).toBe(2);
    unsubscribe();
  });
});
