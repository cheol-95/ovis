import { describe, expect, test } from "bun:test";

import type { ConversationSession } from "../../shared/protocol.ts";
import { translate, type Translate } from "./i18n.ts";
import { sessionSummary } from "./sessionLine.ts";

const t: Translate = (key, vars) => translate("en", key, vars);
const NOW = Date.parse("2026-10-29T06:00:00.000Z");
const goal = { objective: "Ship the session line", status: "active" as const, tokensUsed: 5000, timeUsedSeconds: 90, blockedReason: null };

describe("sessionSummary", () => {
  test("names the session's goal, what it waits on, the time worked and the transcript's size", () => {
    const session: ConversationSession = {
      transcript_bytes: 82 * 1024 * 1024, worked_ms: (8 * 60 + 15) * 60_000, goal,
      waiting: { since: null, tasks: 2, background: [{ source: "terminal-monitors", count: 1 }, { source: "terminal-background-sessions", count: 2 }, { source: "senpi-task", count: 1 }, { source: "goal-monitor", count: 1 }, { source: "someday-queue", count: 4 }], resumes_at: "2026-10-29T06:04:30.000Z" },
    };
    const summary = sessionSummary(session, { now: NOW, live: true, locale: "en", t });
    expect(summary.goal).toEqual(goal);
    expect(summary.worked).toBe("8h 15m");
    expect(summary.size).toBe("82 MB");
    // the goal's own timer is what `resumes` says; an unknown source still counts as work
    expect(summary.waiting?.on).toEqual(["3 tasks", "1 monitor", "2 background terminals", "4 other jobs"]);
    expect(summary.waiting?.resumes).toBe(new Date("2026-10-29T06:04:30.000Z").toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }));
  });

  test("a wait the pane no longer runs, a due time that passed or a goal that is not active say nothing of resuming", () => {
    const waiting = { since: null, tasks: 1, background: [], resumes_at: "2026-10-29T06:04:30.000Z" };
    expect(sessionSummary({ transcript_bytes: 10, worked_ms: 0, goal, waiting }, { now: NOW, live: false, locale: "en", t }).waiting).toBeNull();
    expect(sessionSummary({ transcript_bytes: 10, worked_ms: 0, goal, waiting }, { now: Date.parse("2026-10-29T06:05:00.000Z"), live: true, locale: "en", t }).waiting).toEqual({ on: ["1 task"], resumes: null });
    expect(sessionSummary({ transcript_bytes: 10, worked_ms: 0, goal: { ...goal, status: "complete" }, waiting }, { now: NOW, live: true, locale: "en", t }).waiting?.resumes).toBeNull();
  });

  test("an agent that records no turn time or keeps no goal: worked is unknown, no goal", () => {
    const summary = sessionSummary({ transcript_bytes: 512, worked_ms: null }, { now: NOW, live: true, locale: "en", t });
    expect(summary).toEqual({ goal: null, waiting: null, worked: null, size: "512 B" });
    expect(sessionSummary({ transcript_bytes: 512, worked_ms: 45_000 }, { now: NOW, live: true, locale: "en", t }).worked).toBe("45s");
    expect(sessionSummary({ transcript_bytes: 512, worked_ms: 9 * 60_000 }, { now: NOW, live: true, locale: "en", t }).worked).toBe("9m");
  });
});
