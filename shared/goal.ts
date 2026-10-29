/**
 * omo's goal as its goal calls (`create_goal` / `update_goal` / `get_goal`) state it. Each call
 * answers with the goal as it now stands, `{"goal": {objective, status, tokensUsed,
 * timeUsedSeconds, blockedReason?}}`, or `{"goal": null}` when there is none. The chat reads it
 * from a turn's tool part (src/lib/goals.ts), the server from the whole transcript
 * (server/session-facts.ts): one reading for both.
 */

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "budget_limited";

export interface GoalState {
  objective: string;
  status: GoalStatus;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  blockedReason: string | null;
}

const STATUSES: readonly string[] = ["active", "paused", "blocked", "complete", "budget_limited"];
const GOAL_TOOLS = new Set(["create_goal", "update_goal", "get_goal"]);

export function isGoalTool(name: string): boolean {
  return GOAL_TOOLS.has(name);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * The goal a goal call's parsed answer states: the goal, `null` when it says there is none
 * (`{"goal": null}`, after `/goal clear`), or `undefined` when it says nothing usable (a refusal,
 * an unknown status, not JSON).
 */
export function goalFromAnswer(answer: unknown): GoalState | null | undefined {
  const holder = record(answer);
  if (holder === null || !("goal" in holder)) return undefined;
  if (holder["goal"] === null) return null;
  const goal = record(holder["goal"]);
  const objective = text(goal?.["objective"]);
  const status = goal?.["status"];
  if (goal === null || objective === null || typeof status !== "string" || !STATUSES.includes(status)) return undefined;
  return {
    objective,
    status: status as GoalStatus,
    tokensUsed: count(goal["tokensUsed"]),
    timeUsedSeconds: count(goal["timeUsedSeconds"]),
    blockedReason: text(goal["blockedReason"]),
  };
}
