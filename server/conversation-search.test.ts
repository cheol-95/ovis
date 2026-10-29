import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { HistoryChanged, transcriptPage, type ConversationPage } from "./conversation.ts";
import { searchConversation } from "./conversation-search.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** a prompt, a tool call, its result, some thinking and an answer */
const claudeTurn = (n: number, words: { prompt?: string; answer?: string; tool?: string; thinking?: string } = {}) => [
  { type: "user", timestamp: `2026-09-23T00:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: words.prompt ?? `prompt ${n}` } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: words.thinking ?? `thinking ${n}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: words.tool ?? `out ${n}` }] } },
  { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: words.answer ?? `answer ${n}` }] } },
].map((entry) => JSON.stringify(entry)).join("\n");

function session(count: number, words: Record<number, Parameters<typeof claudeTurn>[1]>): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-chat-search-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, `${Array.from({ length: count }, (_, n) => claudeTurn(n, words[n])).join("\n")}\n`);
  return path;
}

const textOf = (turn: ConversationTurn | undefined) => turn?.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join(" ");

/** The chat's own walk to a hit (ChatView): pages before what it shows, never past the hit's cursor. */
function pageIn(read: (page: ConversationPage) => { turns: ConversationTurn[]; cursor: string | null }, from: string, to: string | null, prompts: number): ConversationTurn[] {
  const pages: ConversationTurn[][] = [];
  let before: string | null = from;
  while (before !== to && before !== null) {
    const page = read({ before, ...(to === null ? {} : { since: to }), prompts });
    pages.unshift(page.turns);
    before = page.cursor;
  }
  expect(before).toBe(to);
  return pages.flat();
}

it("finds a message in a page the chat has not loaded, at the cursor and index its paging reaches", async () => {
  const path = session(160, { 37: { prompt: "Plan the deploy key ROTATION for staging" } });
  const read = (page: ConversationPage) => transcriptPage("claude-transcript", path, page);
  // the chat shows its newest page at its own page size
  const newest = read({ prompts: 10 });
  expect(newest.turns.some((turn) => textOf(turn)?.includes("ROTATION"))).toBe(false);

  const answer = await searchConversation(read, "key rotation", { before: newest.cursor!, history_id: newest.history_id });
  expect(answer.history_id).toBe(newest.history_id);
  expect(answer.next).toBeNull();
  expect(answer.hits).toHaveLength(1);
  const [hit] = answer.hits;
  expect(hit).toMatchObject({ role: "user", ts: "2026-09-23T00:00:37.000Z", snippet: "Plan the deploy key ROTATION for staging", match: { start: 16, length: 12 } });

  const loaded = pageIn(read, newest.cursor!, hit!.cursor, 10);
  expect(textOf(loaded[hit!.index])).toBe("Plan the deploy key ROTATION for staging");
});

it("lists the newest first and matches what was said, not tool output or thinking", async () => {
  const path = session(120, {
    3: { answer: "The flaky test was the cache key." },
    50: { tool: "cache key mismatch in the build log", thinking: "maybe the cache key" },
    90: { prompt: "why does the cache key change?" },
  });
  const read = (page: ConversationPage) => transcriptPage("claude-transcript", path, page);
  const newest = read({ prompts: 10 });
  const answer = await searchConversation(read, "cache key", { before: newest.cursor! });
  expect(answer.hits.map((hit) => [hit.role, hit.snippet])).toEqual([
    ["user", "why does the cache key change?"],
    ["assistant", "The flaky test was the cache key."],
  ]);
  for (const hit of answer.hits) {
    const loaded = pageIn(read, newest.cursor!, hit.cursor, 10);
    expect(textOf(loaded[hit.index])).toBe(hit.snippet);
  }
});

it("cuts a long message to the words around the match", async () => {
  const long = `${"alpha ".repeat(40)}the needle sits here ${"omega ".repeat(60)}`;
  const path = session(80, { 2: { answer: long } });
  const read = (page: ConversationPage) => transcriptPage("claude-transcript", path, page);
  const newest = read({ prompts: 10 });
  const [hit] = (await searchConversation(read, "needle", { before: newest.cursor! })).hits;
  expect(hit!.snippet.startsWith("…")).toBe(true);
  expect(hit!.snippet.endsWith("…")).toBe(true);
  expect(hit!.snippet.length).toBeLessThan(long.length);
  expect(hit!.snippet.slice(hit!.match.start, hit!.match.start + hit!.match.length)).toBe("needle");
});

it("stops at the hit limit with the cursor to search on from", async () => {
  const path = session(200, Object.fromEntries(Array.from({ length: 200 }, (_, n) => [n, { answer: `match ${n}` }])));
  const read = (page: ConversationPage) => transcriptPage("claude-transcript", path, page);
  const newest = read({ prompts: 10 });
  const first = await searchConversation(read, "match", { before: newest.cursor! }, { hits: 5 });
  expect(first.next).not.toBeNull();
  expect(first.hits.length).toBeGreaterThanOrEqual(5);
  const rest = await searchConversation(read, "match", { before: first.next! }, { hits: 1000 });
  expect(rest.next).toBeNull();
  // together they are every older answer, once each, newest first
  expect([...first.hits, ...rest.hits].map((hit) => hit.snippet)).toEqual(Array.from({ length: 190 }, (_, n) => `match ${189 - n}`));
});

it("refuses a history the chat no longer shows", async () => {
  const path = session(80, {});
  const read = (page: ConversationPage) => transcriptPage("claude-transcript", path, page);
  const newest = read({ prompts: 10 });
  await expect(searchConversation(read, "prompt", { before: newest.cursor!, history_id: "another-history" })).rejects.toBeInstanceOf(HistoryChanged);
});
