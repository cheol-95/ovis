import type { ConversationSession, GoalState } from "../../shared/protocol.ts";
import { formatBytes } from "./bridgeProgress.ts";
import type { Translate } from "./i18n.ts";

/**
 * The chat's session line (#1170, #2017): what the whole transcript records of the session,
 * in words. The server reads the facts (server/session-facts.ts); this only words them.
 */
export interface SessionSummary {
  goal: GoalState | null;
  /** what omo waits on before its turn goes on, and when its goal's timer resumes it */
  waiting: { on: string[]; resumes: string | null } | null;
  /** null: this agent's transcript records no turn time */
  worked: string | null;
  size: string;
}

/** `45s`, `9m`, `8h 15m`, in the reader's language */
function formatWorked(ms: number, t: Translate): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t("{s}s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{m}m", { m: minutes });
  return t("{h}h {m}m", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** omo's own names for the work it waits on; the goal's timer and its wake queue are omo's machinery, not work */
const INTERNAL = new Set(["goal-monitor", "omo-wake-queue"]);

function waitingOn(waiting: NonNullable<ConversationSession["waiting"]>, t: Translate): string[] {
  const counts = new Map<string, number>();
  const bump = (kind: string, n: number) => counts.set(kind, (counts.get(kind) ?? 0) + n);
  if (waiting.tasks > 0) bump("tasks", waiting.tasks);
  for (const { source, count } of waiting.background) {
    if (INTERNAL.has(source)) continue;
    bump(source === "senpi-task" ? "tasks" : source === "terminal-monitors" ? "monitors" : source === "terminal-background-sessions" ? "terminals"
      : source === "senpi-codemode" ? "cells" : source === "omo-dag" ? "workflows" : "other", count);
  }
  const words: string[] = [];
  const tasks = counts.get("tasks") ?? 0, monitors = counts.get("monitors") ?? 0, terminals = counts.get("terminals") ?? 0;
  const cells = counts.get("cells") ?? 0, workflows = counts.get("workflows") ?? 0, other = counts.get("other") ?? 0;
  if (tasks > 0) words.push(t(tasks === 1 ? "{n} task" : "{n} tasks", { n: tasks }));
  if (monitors > 0) words.push(t(monitors === 1 ? "{n} monitor" : "{n} monitors", { n: monitors }));
  if (terminals > 0) words.push(t(terminals === 1 ? "{n} background terminal" : "{n} background terminals", { n: terminals }));
  if (cells > 0) words.push(t(cells === 1 ? "{n} code cell" : "{n} code cells", { n: cells }));
  if (workflows > 0) words.push(t(workflows === 1 ? "{n} workflow" : "{n} workflows", { n: workflows }));
  if (other > 0) words.push(t(other === 1 ? "{n} other job" : "{n} other jobs", { n: other }));
  return words;
}

/**
 * `live`: the pane still runs its agent. A wait the transcript last recorded means nothing once
 * the agent is gone, and a resume time is said only while it is ahead and the goal is active.
 */
export function sessionSummary(session: ConversationSession, { now, live, locale, t }: { now: number; live: boolean; locale: string; t: Translate }): SessionSummary {
  const goal = session.goal ?? null;
  let waiting: SessionSummary["waiting"] = null;
  if (live && session.waiting) {
    const due = session.waiting.resumes_at === null ? NaN : Date.parse(session.waiting.resumes_at);
    const resumes = Number.isFinite(due) && due > now && (goal === null || goal.status === "active")
      ? new Date(due).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : null;
    waiting = { on: waitingOn(session.waiting, t), resumes };
  }
  return {
    goal,
    waiting,
    worked: session.worked_ms === null ? null : formatWorked(session.worked_ms, t),
    size: formatBytes(session.transcript_bytes),
  };
}
