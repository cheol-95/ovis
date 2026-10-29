import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { GUIDE_STORAGE_KEY, WELCOME, type GuideState } from "./setupGuideFlow.ts";
import { useSetupGuide } from "./useSetupGuide.ts";

// The real hook over a fake browser: one tab's storage, and the storage events another tab's writes send.
describe("the setup guide closed in another tab", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let hook: ReturnType<typeof useSetupGuide>;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function resumeAt(state: GuideState): Promise<void> {
    records.set(GUIDE_STORAGE_KEY, JSON.stringify({ status: "open", state }));
    function Probe() {
      hook = useSetupGuide({ enabled: true, workspaces: 0, pairingGate: "open", watching: false });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  /** What another tab's write looks like here: the record already in storage, then its event. */
  async function otherTabWrites(value: string): Promise<void> {
    records.set(GUIDE_STORAGE_KEY, value);
    const event = new Event("storage");
    Object.defineProperties(event, { key: { value: GUIDE_STORAGE_KEY }, newValue: { value } });
    await act(async () => { events.dispatchEvent(event); });
  }

  it("closes here when the other tab closes it", async () => {
    await resumeAt({ ...WELCOME, step: "agent" });
    expect(hook.guide?.step).toBe("agent");
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    expect(hook.guide).toBeNull();
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("does not reopen it with a step taken here before the close event arrived", async () => {
    await resumeAt({ ...WELCOME, step: "agent" });
    // the other tab's close lands in storage, its event not yet delivered here
    records.set(GUIDE_STORAGE_KEY, JSON.stringify({ status: "closed" }));
    await act(async () => { hook.dispatch({ type: "skip" }); });
    expect(hook.guide).toBeNull();
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!)).toEqual({ status: "closed" });
  });

  it("opens again here when Settings asks, over a close made elsewhere", async () => {
    await resumeAt({ ...WELCOME, step: "agent" });
    await otherTabWrites(JSON.stringify({ status: "closed" }));
    await act(async () => { window.dispatchEvent(new Event("ovis:open-setup-guide")); });
    expect(hook.guide?.step).toBe("agent");
    expect(JSON.parse(records.get(GUIDE_STORAGE_KEY)!).status).toBe("open");
  });
});
