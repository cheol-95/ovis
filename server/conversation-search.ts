import type { ConversationSearchHit, ConversationSearchResponse } from "../shared/protocol.ts";
import { matchTurn } from "../shared/conversation-search.ts";
import { HistoryChanged, MAX_PAGE_PROMPTS, type ConversationPage, type RecognizedConversation } from "./conversation.ts";

/** A search stops after the page that brings it this many hits; the answer says where to go on. */
export const SEARCH_HITS = 50;
/** ...or after the page that takes it past this long, so a huge session answers in a bounded time. */
export const SEARCH_BUDGET_MS = 2000;

/**
 * Search a conversation's turns before `before`, a page at a time from the newest, through the
 * same pages the chat reads (`read` is paneConversation for one pane), so a hit is placed the way
 * the chat will load it: `cursor` is where its page starts and `index` its turn in that page. The
 * chat pages back to the cursor with `before` + `since`, which ends exactly on it, and the turn is
 * then `index` turns into what it loaded. `next` is the cursor to search on from; null once the
 * beginning was searched. A page from another history (a `/new`, a Codex backtrack) is refused.
 */
export async function searchConversation(
  read: (page: ConversationPage) => RecognizedConversation | Promise<RecognizedConversation>,
  query: string,
  start: { before: string; history_id?: string },
  limits: { hits?: number; ms?: number; signal?: AbortSignal } = {},
): Promise<ConversationSearchResponse> {
  const hitLimit = limits.hits ?? SEARCH_HITS;
  const deadline = performance.now() + (limits.ms ?? SEARCH_BUDGET_MS);
  const hits: ConversationSearchHit[] = [];
  let historyId = start.history_id;
  let before: string | null = start.before;
  while (before !== null) {
    if (limits.signal?.aborted) throw limits.signal.reason;
    const page = await read({ before, prompts: MAX_PAGE_PROMPTS });
    if (historyId !== undefined && page.history_id !== historyId) throw new HistoryChanged();
    historyId = page.history_id;
    for (let index = page.turns.length - 1; index >= 0; index--) {
      const turn = page.turns[index]!;
      const found = matchTurn(turn, query);
      if (found !== null) hits.push({ cursor: page.cursor, index, role: turn.role, ts: turn.ts, ...found });
    }
    // no progress is no page: a store that answers the same cursor again ends the search there
    if (page.cursor === before) break;
    before = page.cursor;
    if (hits.length >= hitLimit || performance.now() > deadline) break;
  }
  return { history_id: historyId ?? "", hits, next: before };
}
