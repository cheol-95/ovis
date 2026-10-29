import { closeSync, openSync, readSync } from "node:fs";

import { goalFromAnswer, isGoalTool, type GoalState } from "../shared/goal.ts";
import type { ConversationSession } from "../shared/protocol.ts";
import type { StreamSource } from "./conversation-shared.ts";

/**
 * The session as its whole transcript records it (#1170, #2017): the chat reads a page of turns,
 * so the goal set hours ago and the time worked before that page are not in it. Each file is
 * read once from the start and then only from where the last read stopped (the stores are
 * append-only; a shorter or replaced file is read again), keeping a few numbers, never the turns.
 */

type Shape = "pi" | "claude" | "codex" | "none";

interface Lifecycle { state: string; since: string | null; tasks: number; background: { source: string; count: number }[] }

interface Scan {
  identity: string;
  shape: Shape;
  /** bytes read, through the last whole line */
  offset: number;
  worked: number;
  counted: boolean;
  /** the pi-shaped turn still open: from its start to its last recorded activity */
  span: { start: number; last: number } | null;
  goal: GoalState | null;
  lifecycle: Lifecycle | null;
  resumesAt: number | null;
}

const scans = new Map<string, Scan>();
const REMEMBERED_FILES = 64;
const CHUNK_BYTES = 1024 * 1024;
/** omo, pi, omp and gjc put a record's type, timestamp and role in its first bytes */
const HEAD_BYTES = 512;
const NEWLINE = 0x0a;

function shapeOf(source: StreamSource): Shape {
  if (source === "omo-transcript" || source === "pi-transcript" || source === "cmd-transcript" || source === "omp-transcript" || source === "gjc-transcript") return "pi";
  if (source === "claude-transcript") return "claude";
  if (source === "codex-transcript") return "codex";
  return "none";
}

export function forgetSessionFacts(): void {
  scans.clear();
}

export function sessionFacts(source: StreamSource, path: string, stat: { dev: number; ino: number; size: number }): ConversationSession {
  const shape = shapeOf(source);
  const identity = `${stat.dev}:${stat.ino}`;
  let scan = scans.get(path);
  if (scan === undefined || scan.identity !== identity || scan.shape !== shape || stat.size < scan.offset) {
    scan = { identity, shape, offset: 0, worked: 0, counted: false, span: null, goal: null, lifecycle: null, resumesAt: null };
  }
  if (shape !== "none" && stat.size > scan.offset) readFrom(path, scan, stat.size);
  scans.delete(path);
  scans.set(path, scan);
  if (scans.size > REMEMBERED_FILES) scans.delete(scans.keys().next().value!);

  const open = scan.span === null ? 0 : scan.span.last - scan.span.start;
  const session: ConversationSession = { transcript_bytes: stat.size, worked_ms: scan.counted ? scan.worked + open : null };
  if (source === "omo-transcript") session.goal = scan.goal;
  const life = scan.lifecycle;
  if (life !== null && (life.state === "waiting_children" || life.state === "waiting_background")) {
    session.waiting = { since: life.since, tasks: life.tasks, background: life.background, resumes_at: scan.resumesAt === null ? null : new Date(scan.resumesAt).toISOString() };
  }
  return session;
}

/** Reads the whole lines from `scan.offset` to `size`; a line still being written waits for the next read. */
function readFrom(path: string, scan: Scan, size: number): void {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return; }
  try {
    // a line longer than a chunk is gathered in pieces, never copied once per chunk
    const pieces: Buffer[] = [];
    let position = scan.offset;
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position));
      const got = readSync(fd, chunk, 0, chunk.length, position);
      if (got <= 0) break;
      position += got;
      const bytes = chunk.subarray(0, got);
      const first = bytes.indexOf(NEWLINE);
      if (first === -1) { pieces.push(bytes); continue; }
      const last = bytes.lastIndexOf(NEWLINE);
      if (pieces.length > 0) {
        readLines(scan, Buffer.concat([...pieces, bytes.subarray(0, first + 1)]));
        pieces.length = 0;
        readLines(scan, bytes.subarray(first + 1, last + 1));
      } else {
        readLines(scan, bytes.subarray(0, last + 1));
      }
      scan.offset = position - (got - last - 1);
      if (last + 1 < got) pieces.push(bytes.subarray(last + 1));
    }
  } finally {
    closeSync(fd);
  }
}

function readLines(scan: Scan, region: Buffer): void {
  if (scan.shape === "pi") {
    let start = 0;
    while (start < region.length) {
      const end = region.indexOf(NEWLINE, start);
      const stop = end === -1 ? region.length : end;
      if (stop > start) piLine(scan, region.subarray(start, stop));
      start = stop + 1;
    }
  } else if (scan.shape === "claude") {
    eachLineWith(region, '"subtype":"turn_duration"', (line) => {
      const entry = record(parse(line));
      const ms = entry?.["durationMs"];
      if (entry?.["type"] === "system" && entry["isSidechain"] !== true && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) add(scan, ms);
    });
  } else if (scan.shape === "codex") {
    eachLineWith(region, '"type":"task_complete"', (line) => {
      const payload = record(record(parse(line))?.["payload"]);
      if (payload?.["type"] !== "task_complete") return;
      const ms = payload["duration_ms"], started = payload["started_at"], completed = payload["completed_at"];
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) add(scan, ms);
      else if (typeof started === "number" && typeof completed === "number" && completed >= started) add(scan, (completed - started) * 1000);
    });
  }
}

/** Each whole line of `region` that holds `needle`, once: the stores keep these records rare. */
function eachLineWith(region: Buffer, needle: string, read: (line: Buffer) => void): void {
  let found = region.indexOf(needle);
  while (found !== -1) {
    const start = region.lastIndexOf(NEWLINE, found) + 1;
    const end = region.indexOf(NEWLINE, found);
    const stop = end === -1 ? region.length : end;
    read(region.subarray(start, stop));
    found = region.indexOf(needle, stop);
  }
}

function add(scan: Scan, ms: number): void {
  scan.worked += ms;
  scan.counted = true;
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;
const ROLE = /"role":"([A-Za-z]+)"/;
const GOAL_TOOL = /"toolName":"(?:create_goal|update_goal|get_goal)"/;

function piLine(scan: Scan, line: Buffer): void {
  const head = line.subarray(0, HEAD_BYTES).toString("utf8");
  if (head.includes('"type":"message"')) {
    let at = Date.parse(TIMESTAMP.exec(head)?.[1] ?? "");
    let role = ROLE.exec(head)?.[1];
    if (Number.isNaN(at) || role === undefined) {
      // another writer's key order: the whole record says it
      const entry = record(parse(line));
      at = Date.parse(typeof entry?.["timestamp"] === "string" ? entry["timestamp"] : "");
      const inner = record(entry?.["message"])?.["role"];
      role = typeof inner === "string" ? inner : undefined;
    }
    if (!Number.isNaN(at)) {
      if (role === "user") startTurn(scan, at);
      else if (role === "assistant" || role === "toolResult") activity(scan, at);
    }
    if (role === "toolResult" && GOAL_TOOL.test(head)) goalLine(scan, line);
    return;
  }
  if (head.includes('"type":"custom_message"') || head.includes('"customType":"engine-turn-start"')) {
    const at = Date.parse(TIMESTAMP.exec(head)?.[1] ?? "");
    if (!Number.isNaN(at)) startTurn(scan, at);
    return;
  }
  if (head.includes('"customType":"session-lifecycle"')) {
    const entry = record(parse(line));
    const data = record(entry?.["data"]);
    if (data === null || typeof data["state"] !== "string") return;
    const waiting = record(data["waitingOn"]);
    const children = waiting?.["children"];
    const background = Array.isArray(waiting?.["background"]) ? waiting["background"] : [];
    scan.lifecycle = {
      state: data["state"],
      since: typeof data["since"] === "string" ? data["since"] : typeof entry?.["timestamp"] === "string" ? entry["timestamp"] : null,
      tasks: typeof children === "number" && Number.isFinite(children) && children > 0 ? children : 0,
      background: background.flatMap((item) => {
        const source = record(item)?.["source"], count = record(item)?.["activeCount"];
        // `delivery:<id>` is omo handing one notification to the agent, not work that runs
        return typeof source === "string" && !source.startsWith("delivery:") && typeof count === "number" && Number.isFinite(count) && count > 0 ? [{ source, count }] : [];
      }),
    };
    return;
  }
  if (head.includes('"customType":"goal-cache-warmup"')) {
    const data = record(record(parse(line))?.["data"]);
    if (data?.["phase"] === "scheduled") scan.resumesAt = typeof data["dueAtMs"] === "number" && Number.isFinite(data["dueAtMs"]) ? data["dueAtMs"] : null;
    else if (data?.["phase"] === "resumed") scan.resumesAt = null;
  }
}

function startTurn(scan: Scan, at: number): void {
  if (scan.span !== null) add(scan, scan.span.last - scan.span.start);
  scan.span = { start: at, last: at };
  scan.counted = true;
}

function activity(scan: Scan, at: number): void {
  if (scan.span === null) { scan.span = { start: at, last: at }; scan.counted = true; }
  else if (at > scan.span.last) scan.span.last = at;
}

/** A goal call's answer: omo keeps the goal in `details`, and its text says the same. */
function goalLine(scan: Scan, line: Buffer): void {
  const message = record(record(parse(line))?.["message"]);
  if (message === null || typeof message["toolName"] !== "string" || !isGoalTool(message["toolName"]) || message["isError"] === true) return;
  const details = record(message["details"]);
  let stated = details !== null && "goal" in details ? goalFromAnswer(details) : undefined;
  if (stated === undefined && Array.isArray(message["content"])) {
    const text = message["content"].map((part) => record(part)?.["text"]).find((value) => typeof value === "string");
    if (typeof text === "string") stated = goalFromAnswer(parse(text));
  }
  if (stated !== undefined) scan.goal = stated;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parse(value: Buffer | string): unknown {
  try { return JSON.parse(typeof value === "string" ? value : value.toString("utf8")); } catch { return undefined; }
}
