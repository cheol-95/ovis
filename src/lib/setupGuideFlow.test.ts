import { describe, expect, it } from "bun:test";

import { autoOpen, guideProgress, guideStep, readGuide, REOPENED, saveGuide, usageOnByDefault, WELCOME, type FreshFacts, type GuideState } from "./setupGuideFlow.ts";

const FRESH: FreshFacts = { workspaces: 0, savedSettings: false, sharedRevision: 0, pairingGate: "open", watching: false };

const memory = (): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const walk = (state: GuideState, ...events: Parameters<typeof guideStep>[1][]): GuideState => events.reduce(guideStep, state);

describe("autoOpen", () => {
  it("opens the welcome on a fresh install only", () => {
    expect(autoOpen(FRESH)).toBe(true);
    // a server whose pairing state is not known has no paired device to show for it
    expect(autoOpen({ ...FRESH, pairingGate: "unavailable" })).toBe(true);
  });

  it("stays shut once anything shows Ovis was used here before", () => {
    expect(autoOpen({ ...FRESH, workspaces: 1 })).toBe(false);
    expect(autoOpen({ ...FRESH, savedSettings: true })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: 3 })).toBe(false);
    expect(autoOpen({ ...FRESH, pairingGate: "closed" })).toBe(false);
    expect(autoOpen({ ...FRESH, watching: true })).toBe(false);
  });

  it("does not guess while a fact is still unknown", () => {
    expect(autoOpen({ ...FRESH, workspaces: null })).toBe(false);
    expect(autoOpen({ ...FRESH, sharedRevision: null })).toBe(false);
  });
});

describe("guideStep", () => {
  it("walks Agent, Plan usage, Phone, Alerts to Done, recording each outcome", () => {
    const agent = walk(WELCOME, { type: "begin" });
    expect(agent.step).toBe("agent");
    const chosen = guideStep(agent, { type: "choose", plan: "claude", agent: "claude" });
    expect(chosen).toMatchObject({ step: "agent", plan: "claude", agent: "claude" });
    const done = walk(chosen, { type: "agent-ready", signedIn: true }, { type: "complete" }, { type: "skip" }, { type: "complete" });
    expect(done.step).toBe("done");
    expect(done.outcomes).toEqual({ agent: "done", usage: "done", phone: "skipped", alerts: "done" });
    expect(done.signedIn).toBe(true);
  });

  it("skips the agent step without an agent, and Back forgets the pick", () => {
    const chosen = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "free", agent: "opencode" });
    expect(guideStep(chosen, { type: "back" })).toMatchObject({ step: "agent", plan: null, agent: null });
    const skipped = guideStep(chosen, { type: "skip" });
    expect(skipped).toMatchObject({ step: "usage", agent: null, outcomes: { agent: "skipped" } });
  });

  it("ignores events that do not belong to the step shown", () => {
    expect(guideStep(WELCOME, { type: "skip" })).toBe(WELCOME);
    expect(guideStep(WELCOME, { type: "agent-ready", signedIn: true })).toBe(WELCOME);
    const usage = walk(WELCOME, { type: "begin" }, { type: "skip" });
    expect(guideStep(usage, { type: "agent-ready", signedIn: true })).toBe(usage);
    const end = walk(usage, { type: "skip" }, { type: "skip" }, { type: "skip" });
    expect(end.step).toBe("done");
    expect(guideStep(end, { type: "skip" })).toBe(end);
  });
});

describe("guideProgress", () => {
  it("numbers the four steps and marks skipped ones", () => {
    const alerts = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "chatgpt", agent: "codex" }, { type: "agent-ready", signedIn: false }, { type: "complete" }, { type: "skip" });
    const progress = guideProgress(alerts);
    expect(progress.number).toBe(4);
    expect(progress.segments.map((segment) => `${segment.id}:${segment.state}`)).toEqual(["agent:done", "usage:done", "phone:skipped", "alerts:now", "done:next"]);
    expect(guideProgress(walk(alerts, { type: "complete" })).number).toBe(4);
  });
});

describe("usageOnByDefault", () => {
  it("is on only after a sign-in in the agent step", () => {
    const chosen = walk(WELCOME, { type: "begin" }, { type: "choose", plan: "claude", agent: "claude" });
    expect(usageOnByDefault(guideStep(chosen, { type: "agent-ready", signedIn: true }))).toBe(true);
    expect(usageOnByDefault(guideStep(chosen, { type: "agent-ready", signedIn: false }))).toBe(false);
    expect(usageOnByDefault(guideStep(chosen, { type: "skip" }))).toBe(false);
  });
});

describe("readGuide and saveGuide", () => {
  it("keeps an open guide to resume and a closed one to stay shut", () => {
    const storage = memory();
    expect(readGuide(storage)).toBeNull();
    const usage = walk(WELCOME, { type: "begin" }, { type: "skip" });
    saveGuide(storage, usage);
    expect(readGuide(storage)).toEqual({ status: "open", state: usage });
    saveGuide(storage, null);
    expect(readGuide(storage)).toEqual({ status: "closed" });
  });

  it("reads a damaged record as closed, never as a guide to show", () => {
    const storage = memory();
    for (const raw of ["{", "[]", "{\"status\":\"open\",\"state\":{\"step\":\"nowhere\"}}", "{\"status\":\"open\"}"]) {
      storage.values.set("ovis:setup-guide", raw);
      expect(readGuide(storage)).toEqual({ status: "closed" });
    }
  });

  it("opens again at the first step when asked", () => {
    expect(REOPENED.step).toBe("agent");
    expect(REOPENED.outcomes).toEqual({});
  });
});
