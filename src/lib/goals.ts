import type { ConversationPart } from "../../shared/protocol.ts";
import { goalFromAnswer, isGoalTool, type GoalState } from "../../shared/goal.ts";

export { isGoalTool, type GoalState, type GoalStatus } from "../../shared/goal.ts";

/**
 * omo's goal as the chat shows it on the turn (the reading itself is shared/goal.ts). An answer
 * cut for length (a long objective) loses its JSON: a `create_goal` still has its objective in the
 * call, and is active by definition; an `update_goal` without its answer says nothing usable.
 */

type Tool = Extract<ConversationPart, { kind: "tool" }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

/** The goal one call left, or null when it left none the chat can show. */
export function goalOf(part: Tool): GoalState | null {
  if (!isGoalTool(part.name) || part.error) return null;
  const stated = goalFromAnswer(parse(part.output));
  if (stated) return stated;
  const asked = part.name === "create_goal" && part.output_ref !== undefined ? text(record(parse(part.input))?.["objective"]) : null;
  return asked === null ? null : { objective: asked, status: "active", tokensUsed: null, timeUsedSeconds: null, blockedReason: null };
}

/** `45s`, `12m`, `2h 5m`: how long omo has worked on the goal. */
export function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A goal call that answered `{"goal": null}`: there is no goal (any more). */
function saysNoGoal(part: Tool): boolean {
  return isGoalTool(part.name) && !part.error && goalFromAnswer(parse(part.output)) === null;
}

/** The goal as the turn's last goal call left it; a later call that says there is none clears it. */
export function turnGoal(parts: readonly ConversationPart[]): GoalState | null {
  let latest: GoalState | null = null;
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    latest = saysNoGoal(part) ? null : goalOf(part) ?? latest;
  }
  return latest;
}
