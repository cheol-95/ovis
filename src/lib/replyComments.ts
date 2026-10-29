import { SEND_LEASE_MS } from "./composerDraft.ts";
import { paneLifetimes, REPLY_COMMENTS_MOVED_PREFIX, REPLY_COMMENTS_PREFIX } from "./paneLifetime.ts";

/**
 * Comments on parts of an agent's replies (#511): the text a reader selected in one reply and what
 * they want to say about it. They wait on this device, per pane, until the next message the pane's
 * composer sends, which carries them first, each as a quote and then the comment.
 *
 * Stored under `ovis:reply-comments:<paneStorageId>` through the pane-state storage
 * (lib/paneLifetime.ts), like the message draft: a herdr that replaced the pane's takes them with
 * its panes, since the reply they quote is gone with it. A send on its way and a pane move are kept
 * there too (#2356), so every tab of the browser sees them: each comment a send carries says when it
 * was taken, and a moved pane's old ID says where its comments went.
 */
export interface ReplyComment {
  id: string;
  /** the reply's words as the reader selected them, as a copy carries them */
  quote: string;
  comment: string;
  /**
   * when a send, from any tab of this browser, took it: no other send takes it until that one settles,
   * or its lease runs out (SEND_LEASE_MS, a tab that closed mid-send never settles)
   */
  sending?: number;
}

type CommentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export { REPLY_COMMENTS_PREFIX };
export const replyCommentsKey = (paneStorageId: string): string => REPLY_COMMENTS_PREFIX + paneStorageId;
const NONE: readonly ReplyComment[] = [];

function parse(raw: string | null): readonly ReplyComment[] {
  if (raw === null) return NONE;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return NONE;
    const list = value.filter((item): item is ReplyComment => typeof item === "object" && item !== null
      && typeof item.id === "string" && typeof item.quote === "string" && typeof item.comment === "string"
      && item.quote.trim() !== "" && item.comment.trim() !== "");
    return list.length > 0 ? list : NONE;
  } catch {
    return NONE;
  }
}

export class ReplyCommentStore {
  /** what was read for each key, with the raw text it was read from: a read returns the same array until it changes */
  private cache = new Map<string, { raw: string | null; list: readonly ReplyComment[] }>();
  private listeners = new Set<() => void>();
  /**
   * the pane ID each list this tab moved went to (lib/paneMove.ts): a send begun under the old one
   * settles there too. Storage keeps it for the other tabs (REPLY_COMMENTS_MOVED_PREFIX)
   */
  private forwards = new Map<string, string>();
  /** the comments this tab's sends on their way carry, by id, also when storage refused to mark them */
  private reserved = new Set<string>();
  private reservations = 0;
  /** when the earliest lease of another tab's send this tab is waiting out ends */
  private wake: number | null = null;
  constructor(
    private storage: () => CommentStorage = () => paneLifetimes.paneStorage,
    // unique across the tabs that share the list: a send removes and reserves its comments by id
    private newId: () => string = () => `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint32Array(2))].map((part) => part.toString(36)).join("-")}`,
    private schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
  ) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read = (key: string): readonly ReplyComment[] => {
    let raw: string | null = null;
    try { raw = this.storage().getItem(key); } catch { /* private mode: none */ }
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.raw === raw) return cached.list;
    const list = parse(raw);
    this.cache.set(key, { raw, list });
    return list;
  };
  private write(key: string, list: readonly ReplyComment[]): boolean {
    try {
      if (list.length === 0) this.storage().removeItem(key);
      else this.storage().setItem(key, JSON.stringify(list));
    } catch {
      return false;
    }
    this.notify();
    return true;
  }
  /** false: an empty quote or comment, or storage refused it */
  add(key: string, quote: string, comment: string): boolean {
    if (quote.trim() === "" || comment.trim() === "") return false;
    return this.write(key, [...this.read(key), { id: this.newId(), quote, comment: comment.trim() }]);
  }
  remove(key: string, id: string): void {
    const list = this.read(key);
    if (list.some((item) => item.id === id)) this.write(key, list.filter((item) => item.id !== id));
  }
  /** Changes whenever a reservation does: a reader of `unreserved` reads again. */
  reservation = (): number => this.reservations;
  /** A send under `key` carries them: no send from any tab takes them until it settles, wherever they move. */
  reserve(key: string, sent: readonly ReplyComment[]): void {
    if (sent.length === 0) return;
    for (const item of sent) this.reserved.add(item.id);
    this.reservations++;
    this.mark(key, sent, Date.now());
    this.notify();
  }
  /** The send settled: what it carried is free again, here or wherever it moved (a sent one is gone already). */
  release(key: string, sent: readonly ReplyComment[]): void {
    let changed = false;
    for (const item of sent) changed = this.reserved.delete(item.id) || changed;
    this.mark(key, sent, undefined);
    if (!changed) return;
    this.reservations++;
    this.notify();
  }
  /** Marks the comments in storage as taken by a send at `at`, or as free, wherever they went since. */
  private mark(key: string, sent: readonly ReplyComment[], at: number | undefined): void {
    const ids = new Set(sent.map((item) => item.id));
    for (const where of this.chain(key)) {
      const list = this.read(where);
      if (!list.some((item) => ids.has(item.id) && item.sending !== at)) continue;
      this.write(where, list.map((item) => {
        if (!ids.has(item.id)) return item;
        const { sending: _, ...free } = item;
        return at === undefined ? free : { ...free, sending: at };
      }));
    }
  }
  /** The comments no send on its way carries, from this tab or another; wakes the readers when another tab's lease runs out. */
  unreserved(list: readonly ReplyComment[]): readonly ReplyComment[] {
    const now = Date.now();
    const free: ReplyComment[] = [];
    let ends = Infinity;
    for (const item of list) {
      if (this.reserved.has(item.id)) continue;
      if (typeof item.sending !== "number" || now - item.sending > SEND_LEASE_MS) free.push(item);
      else ends = Math.min(ends, item.sending + SEND_LEASE_MS);
    }
    if (ends !== Infinity && (this.wake === null || ends < this.wake)) {
      const at = ends;
      this.wake = at;
      this.schedule(() => {
        if (this.wake !== at) return;
        this.wake = null;
        this.reservations++;
        this.notify();
      }, at - now + 1);
    }
    return free.length === list.length ? list : free;
  }
  /** Removes the comments a sent message carried, by id: one written meanwhile stays for the next. */
  removeSent(key: string, sent: readonly ReplyComment[]): void {
    const ids = new Set(sent.map((item) => item.id));
    for (const at of this.chain(key)) {
      const list = this.read(at);
      if (list.some((item) => ids.has(item.id))) this.write(at, list.filter((item) => !ids.has(item.id)));
    }
  }
  /** `key` and every key its list moved on to since */
  private chain(key: string): string[] {
    const keys = [key];
    for (let next = this.forward(key); next !== undefined && !keys.includes(next); next = this.forward(next)) keys.push(next);
    return keys;
  }
  /** Where `key`'s list went: as stored by whichever tab moved it, while a send begun before could still be on its way. */
  private forward(key: string): string | undefined {
    if (key.startsWith(REPLY_COMMENTS_PREFIX)) {
      const record = REPLY_COMMENTS_MOVED_PREFIX + key.slice(REPLY_COMMENTS_PREFIX.length);
      try {
        const raw = this.storage().getItem(record);
        if (raw !== null) {
          const value: unknown = JSON.parse(raw);
          if (typeof value === "object" && value !== null && "to" in value && "at" in value && typeof value.to === "string"
            && value.to.startsWith(REPLY_COMMENTS_PREFIX) && typeof value.at === "number" && Date.now() - value.at <= SEND_LEASE_MS) return value.to;
          // every send begun before that move has settled by now
          this.storage().removeItem(record);
        }
      } catch { /* unreadable or refused: this tab's own record below */ }
    }
    return this.forwards.get(key);
  }
  /**
   * herdr gave the pane a new ID: all its waiting comments go with it, after any the new ID holds
   * already, and a send begun under the old ID still removes the ones it carried once it is acknowledged.
   */
  move(from: string, to: string): void {
    const moving = this.read(from);
    if (moving.length === 0 || from === to) return;
    const there = this.read(to);
    const held = new Set(there.map((item) => item.id));
    if (!this.write(to, [...there, ...moving.filter((item) => !held.has(item.id))])) return;
    this.write(from, NONE);
    this.forwards.set(from, to);
    // for a send another tab of this browser began under the old ID (#2356)
    if (from.startsWith(REPLY_COMMENTS_PREFIX)) {
      try { this.storage().setItem(REPLY_COMMENTS_MOVED_PREFIX + from.slice(REPLY_COMMENTS_PREFIX.length), JSON.stringify({ to, at: Date.now() })); }
      catch { /* storage refused: this tab's own record still holds */ }
    }
  }
  clear(key: string): void {
    if (this.read(key).length > 0) this.write(key, NONE);
  }
  /** Another tab or a retired herdr changed storage: readers read again. */
  refresh(): void { this.notify(); }
}

export const replyComments = new ReplyCommentStore();
paneLifetimes.onRetire(() => replyComments.refresh());
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === null || event.key.startsWith(REPLY_COMMENTS_PREFIX)) replyComments.refresh();
});

/** `> ` before each line of the quote; its blank lines stay inside the quote as a bare `>`. */
export function quoteBlock(quote: string): string {
  const lines = quote.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "").split("\n");
  return lines.map((line) => line.trim() === "" ? ">" : `> ${line}`).join("\n");
}

/**
 * The message that carries the comments: each comment's quote and then the comment, in the order
 * they were written, a blank line between them, and the typed text after them. A message may be
 * comments alone.
 */
export function messageWithComments(comments: readonly ReplyComment[], text: string): string {
  const parts = comments.map((item) => `${quoteBlock(item.quote)}\n${item.comment.trim()}`);
  if (text.trim() !== "") parts.push(text);
  return parts.join("\n\n");
}

/**
 * Whether a send leaves the waiting comments for the next message: a slash command or a `!` shell line
 * (the agent runs them, and a quote before one would turn it into prose), or the answer to the agent's
 * open question.
 */
export function commentsWait(text: string, answering: boolean): boolean {
  return answering || /^[/!]/.test(text.trimStart());
}
