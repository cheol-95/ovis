import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetSessionFacts, sessionFacts } from "./session-facts.ts";

const dirs: string[] = [];
afterEach(() => {
  forgetSessionFacts();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(name: string, records: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "session-facts-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
}
const append = (path: string, records: readonly unknown[]): void => appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
const at = (second: number): string => new Date(Date.UTC(2026, 9, 29, 6, 0, second)).toISOString();

// omo's own record shapes, as a session file holds them (key order as omo writes it)
const message = (second: number, role: string, extra: Record<string, unknown> = {}) => ({ type: "message", id: `m${second}`, parentId: null, timestamp: at(second), message: { role, content: [{ type: "text", text: "…" }], timestamp: Date.parse(at(second)), ...extra } });
const goalResult = (second: number, tool: string, goal: unknown) => message(second, "toolResult", { toolCallId: `c${second}`, toolName: tool, content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal }, isError: false });
const custom = (second: number, customType: string, data: unknown) => ({ type: "custom", customType, data, id: `x${second}`, parentId: null, timestamp: at(second) });
const lifecycle = (second: number, state: string, children: number, background: { source: string; activeCount: number }[]) =>
  custom(second, "session-lifecycle", { state, seq: second, since: at(second), waitingOn: { children, background, human: [] }, runActive: state === "running" });
const goal = (status: string) => ({ threadId: "t", objective: "Ship the session line", status, tokensUsed: 5000, timeUsedSeconds: 90 });

describe("sessionFacts", () => {
  test("omo: the goal as the last goal call left it, the turns' working time and what it waits on", () => {
    const due = Date.parse(at(400));
    const path = file("omo.jsonl", [
      message(0, "user"), message(5, "assistant"), goalResult(6, "create_goal", goal("active")), message(10, "assistant"),
      // a goal continuation starts the next turn on its own: 20 s idle between is not work
      custom(30, "engine-turn-start", { customType: "goal-continuation" }), message(40, "assistant"),
      lifecycle(41, "waiting_background", 2, [{ source: "terminal-monitors", activeCount: 1 }, { source: "omo-dag", activeCount: 0 }, { source: "delivery:senpi-monitor:notification:0b1c", activeCount: 1 }]),
      custom(41, "goal-cache-warmup", { phase: "scheduled", dueAtMs: due, delayMs: 270000, wakeSources: { "senpi-task": 2 } }),
    ]);
    const facts = sessionFacts("omo-transcript", path, statSync(path));
    expect(facts.transcript_bytes).toBe(statSync(path).size);
    expect(facts.worked_ms).toBe(20_000);
    expect(facts.goal).toEqual({ objective: "Ship the session line", status: "active", tokensUsed: 5000, timeUsedSeconds: 90, blockedReason: null });
    expect(facts.waiting).toEqual({ since: at(41), tasks: 2, background: [{ source: "terminal-monitors", count: 1 }], resumes_at: new Date(due).toISOString() });
  });

  test("omo: an append is read from where the last read stopped, and moves every fact on", () => {
    const path = file("omo.jsonl", [message(0, "user"), goalResult(2, "create_goal", goal("active")), lifecycle(3, "waiting_children", 1, []), custom(3, "goal-cache-warmup", { phase: "scheduled", dueAtMs: Date.parse(at(300)) })]);
    expect(sessionFacts("omo-transcript", path, statSync(path)).waiting?.tasks).toBe(1);
    append(path, [
      custom(300, "goal-cache-warmup", { phase: "resumed", wakeCause: "timer" }), lifecycle(300, "running", 0, []),
      custom(300, "engine-turn-start", { customType: "goal-continuation" }), message(310, "assistant"), goalResult(312, "update_goal", goal("complete")),
    ]);
    const facts = sessionFacts("omo-transcript", path, statSync(path));
    expect(facts.waiting).toBeUndefined();
    expect(facts.goal?.status).toBe("complete");
    expect(facts.worked_ms).toBe(2_000 + 12_000);
    // `/goal clear`: a goal call that says there is none
    append(path, [goalResult(320, "get_goal", null)]);
    expect(sessionFacts("omo-transcript", path, statSync(path)).goal).toBeNull();
  });

  test("a line still being written waits for its newline; a refused goal call changes nothing", () => {
    const path = file("omo.jsonl", [message(0, "user"), goalResult(1, "create_goal", goal("active"))]);
    const refused = message(2, "toolResult", { toolName: "create_goal", content: [{ type: "text", text: "Cannot create a new goal because this thread already has an unfinished goal" }], isError: false });
    const half = JSON.stringify(goalResult(3, "update_goal", goal("blocked")));
    appendFileSync(path, `${JSON.stringify(refused)}\n${half.slice(0, 40)}`);
    expect(sessionFacts("omo-transcript", path, statSync(path)).goal?.status).toBe("active");
    appendFileSync(path, `${half.slice(40)}\n`);
    expect(sessionFacts("omo-transcript", path, statSync(path)).goal?.status).toBe("blocked");
  });

  test("a file replaced by a shorter one is read again from its start", () => {
    const path = file("omo.jsonl", [message(0, "user"), message(50, "assistant"), goalResult(51, "create_goal", goal("active"))]);
    expect(sessionFacts("omo-transcript", path, statSync(path)).worked_ms).toBe(51_000);
    writeFileSync(path, `${JSON.stringify(message(0, "user"))}\n${JSON.stringify(message(4, "assistant"))}\n`);
    const facts = sessionFacts("omo-transcript", path, statSync(path));
    expect(facts.worked_ms).toBe(4_000);
    expect(facts.goal).toBeNull();
  });

  test("Claude sums its turn_duration entries, Codex its task_complete durations", () => {
    const claude = file("claude.jsonl", [
      { type: "user", isSidechain: false, timestamp: at(0), message: { role: "user", content: "hi" } },
      { parentUuid: "a", isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 1200, timestamp: at(2) },
      { parentUuid: "b", isSidechain: true, type: "system", subtype: "turn_duration", durationMs: 99_999, timestamp: at(3) },
      { parentUuid: "c", isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 800, timestamp: at(9) },
    ]);
    const facts = sessionFacts("claude-transcript", claude, statSync(claude));
    expect(facts.worked_ms).toBe(2000);
    expect(facts.goal).toBeUndefined();
    expect(facts.waiting).toBeUndefined();
    const codex = file("rollout.jsonl", [
      { timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: "1" } },
      { timestamp: at(80), type: "event_msg", payload: { type: "task_complete", turn_id: "1", started_at: 1793005548, completed_at: 1793005628, duration_ms: 79223 } },
      // an older Codex records the times only
      { timestamp: at(90), type: "event_msg", payload: { type: "task_complete", turn_id: "2", started_at: 1793005700, completed_at: 1793005711 } },
    ]);
    expect(sessionFacts("codex-transcript", codex, statSync(codex)).worked_ms).toBe(79223 + 11_000);
  });

  test("an agent whose transcript records no turn time reports its size and an unknown worked time", () => {
    const path = file("copilot.jsonl", [{ type: "user.message", data: { content: "hi" } }]);
    expect(sessionFacts("copilot-transcript", path, statSync(path))).toEqual({ transcript_bytes: statSync(path).size, worked_ms: null });
    const empty = file("omo.jsonl", []);
    expect(sessionFacts("omo-transcript", empty, statSync(empty))).toEqual({ transcript_bytes: 0, worked_ms: null, goal: null });
  });
});
