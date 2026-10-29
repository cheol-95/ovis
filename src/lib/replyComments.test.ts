import { describe, expect, it, setSystemTime } from "bun:test";
import { SEND_LEASE_MS } from "./composerDraft.ts";
import { commentsWait, messageWithComments, quoteBlock, ReplyCommentStore } from "./replyComments.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } } };
}

describe("reply comments", () => {
  it("sends each comment as its quote and then the comment, in the order written, before the typed text", () => {
    const comments = [
      { id: "a", quote: "backfill it from updated_at", comment: "Backfill in batches of 1,000, the table has 40 million rows." },
      { id: "b", quote: "replay the local edit on top of it", comment: "If both sides changed the same field, ask instead of replaying." },
    ];
    expect(messageWithComments(comments, "Go ahead with step 1.")).toBe(
      "> backfill it from updated_at\nBackfill in batches of 1,000, the table has 40 million rows.\n\n"
      + "> replay the local edit on top of it\nIf both sides changed the same field, ask instead of replaying.\n\n"
      + "Go ahead with step 1.");
    expect(messageWithComments(comments.slice(0, 1), "  ")).toBe("> backfill it from updated_at\nBackfill in batches of 1,000, the table has 40 million rows.");
  });

  it("quotes every line of a selection across paragraphs, its blank lines kept inside the quote", () => {
    expect(quoteBlock("First item\r\nSecond item\n\nNext paragraph.\n")).toBe("> First item\n> Second item\n>\n> Next paragraph.");
  });

  it("leaves the comments for the next message under a slash command or an answer", () => {
    expect(commentsWait("  /compact", false)).toBe(true);
    expect(commentsWait("!git status", false)).toBe(true);
    expect(commentsWait("Go ahead", true)).toBe(true);
    expect(commentsWait("Go ahead with /tmp/x", false)).toBe(false);
  });

  it("keeps a pane's comments, removes one or the sent ones by id, and reads the same list until it changes", () => {
    const { map, storage } = memoryStorage();
    let next = 0;
    const store = new ReplyCommentStore(() => storage, () => `c${++next}`);
    let heard = 0;
    store.subscribe(() => { heard++; });
    expect(store.add("k", "quote one", "  first  ")).toBe(true);
    expect(heard).toBe(1);
    expect(store.add("k", "quote two", "second")).toBe(true);
    expect(store.add("k", " ", "empty quote")).toBe(false);
    expect(store.add("k", "quote", " ")).toBe(false);
    const list = store.read("k");
    expect(store.read("k")).toBe(list);
    expect(list.map((item) => [item.id, item.comment])).toEqual([["c1", "first"], ["c2", "second"]]);
    const sent = list.slice(0, 1);
    store.add("k", "quote three", "written while the first was on its way");
    store.removeSent("k", sent);
    expect(store.read("k").map((item) => item.id)).toEqual(["c2", "c3"]);
    store.remove("k", "c2");
    store.clear("k");
    expect(store.read("k")).toEqual([]);
    expect(map.has("k")).toBe(false);
  });

  it("reads a stored list another tab wrote, and nothing from a value that is not one", () => {
    const { map, storage } = memoryStorage();
    const store = new ReplyCommentStore(() => storage);
    map.set("k", JSON.stringify([{ id: "x", quote: "q", comment: "c" }, { id: 1, quote: "q", comment: "c" }, { id: "y", quote: "", comment: "c" }]));
    expect(store.read("k")).toEqual([{ id: "x", quote: "q", comment: "c" }]);
    map.set("k", "{not json");
    expect(store.read("k")).toEqual([]);
  });

  it("gives the comments two tabs save at the same instant different ids (#2356)", () => {
    const { storage } = memoryStorage();
    try {
      setSystemTime(new Date("2026-10-30T00:00:00Z"));
      const one = new ReplyCommentStore(() => storage), other = new ReplyCommentStore(() => storage);
      one.add("k", "quote", "from one tab");
      other.add("k", "quote", "from another");
      const [first, second] = one.read("k");
      expect(first!.id).not.toBe(second!.id);
    } finally {
      setSystemTime();
    }
  });

  it("frees the comments a closed tab's send reserved once its lease runs out, and tells the composer (#2356)", () => {
    const { storage } = memoryStorage();
    const wakeUps: Array<{ run: () => void; ms: number }> = [];
    const closed = new ReplyCommentStore(() => storage);
    const other = new ReplyCommentStore(() => storage, undefined, (run, ms) => { wakeUps.push({ run, ms }); return 0; });
    const start = Date.now();
    try {
      setSystemTime(start);
      closed.add("k", "quote", "carried");
      closed.reserve("k", closed.read("k"));
      // the sending tab closes without settling its send
      expect(other.unreserved(other.read("k"))).toEqual([]);
      expect(wakeUps.length).toBe(1);
      expect(wakeUps[0]!.ms).toBeGreaterThan(SEND_LEASE_MS - 1000);
      let told = 0;
      other.subscribe(() => { told += 1; });
      const reservation = other.reservation();
      setSystemTime(start + SEND_LEASE_MS + 1);
      wakeUps[0]!.run();
      expect(told).toBe(1);
      expect(other.reservation()).not.toBe(reservation);
      expect(other.unreserved(other.read("k")).map((item) => item.comment)).toEqual(["carried"]);
    } finally {
      setSystemTime();
    }
  });
});
