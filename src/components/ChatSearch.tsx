import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ConversationSearchResponse, ConversationTurn } from "../../shared/protocol.ts";
import { matchTurn, SEARCH_QUERY_MAX, type TurnMatch } from "../../shared/conversation-search.ts";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { useLocalDay } from "../lib/localDay.ts";
import "./ChatSearch.css";

/** A hit to show: a loaded turn by its index in the chat, or an older one by its page (ConversationSearchHit). */
export type ChatSearchPick = { loaded: true; index: number } | { loaded: false; cursor: string | null; index: number };

type Hit = TurnMatch & { key: string; role: ConversationTurn["role"]; ts: string | null; pick: ChatSearchPick };

/** What the bridge found before the loaded turns: for the query, the cursor and the history it was asked with. */
interface Older {
  key: string;
  hits: Hit[];
  next: string | null;
  state: "loading" | "idle" | "failed";
}

const TYPING_MS = 250;

/**
 * Search the pane's conversation (#2018): what the user wrote and the agent's answers, as a list of
 * snippets; picking one shows that message. The loaded turns are searched here, the older pages by
 * the bridge, from the cursor before the loaded turns. Codex's Find in chat searches the same parts
 * on its server; this lists matches rather than highlighting them in place.
 */
export function ChatSearch({ open, focusRequest, turns, before, historyId, search, onPick, onClose, paging }: {
  open: boolean;
  focusRequest: number;
  turns: ConversationTurn[];
  /** the cursor before the loaded turns: null at the conversation's beginning, undefined when unknown */
  before: string | null | undefined;
  historyId: string | undefined;
  search: (query: string, before: string, signal: AbortSignal) => Promise<ConversationSearchResponse>;
  onPick: (pick: ChatSearchPick) => void;
  onClose: () => void;
  /** the chat is loading the pages down to a picked message, or that failed */
  paging: "idle" | "loading" | "failed";
}) {
  const t = useT();
  const today = useLocalDay();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState<Older | null>(null);
  const reading = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open, focusRequest]);

  // what is typed is searched once typing pauses
  useEffect(() => {
    const trimmed = text.trim().slice(0, SEARCH_QUERY_MAX);
    const timer = setTimeout(() => setQuery(trimmed), TYPING_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const loaded = useMemo((): Hit[] => {
    if (query === "") return [];
    const hits: Hit[] = [];
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index]!;
      const found = matchTurn(turn, query);
      if (found !== null) hits.push({ ...found, key: `loaded:${index}`, role: turn.role, ts: turn.ts, pick: { loaded: true, index } });
    }
    return hits;
  }, [turns, query]);

  // the older pages are asked for the query, from where the loaded turns start, in the history they
  // belong to: a page loaded since, or another history, asks again
  const olderKey = query !== "" && typeof before === "string" ? `${historyId ?? ""}\0${before}\0${query}` : null;
  const ask = (key: string, from: string, previous: Hit[]): void => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setOlder({ key, hits: previous, next: from, state: "loading" });
    search(query, from, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      const hits = answer.hits.map((hit, n): Hit => ({ snippet: hit.snippet, match: hit.match, key: `older:${from}:${n}`, role: hit.role, ts: hit.ts, pick: { loaded: false, cursor: hit.cursor, index: hit.index } }));
      setOlder({ key, hits: [...previous, ...hits], next: answer.next, state: "idle" });
    }, () => {
      if (!controller.signal.aborted) setOlder({ key, hits: previous, next: from, state: "failed" });
    });
  };
  useEffect(() => {
    if (!open || olderKey === null || typeof before !== "string") return;
    if (older?.key === olderKey) return;
    ask(olderKey, before, []);
  }, [open, olderKey]);
  useEffect(() => () => reading.current?.abort(), []);

  const current = older !== null && older.key === olderKey ? older : null;
  const hits = [...loaded, ...(current?.hits ?? [])];
  const searching = query !== "" && (text.trim() !== query || current?.state === "loading");
  const status = paging === "loading" ? t("Loading earlier messages…")
    : paging === "failed" ? t("Couldn't load earlier messages")
    : query === "" ? t("Searches what you wrote and the agent's answers, not tool output or thinking.")
    : searching && hits.length === 0 ? t("Searching earlier messages…")
    : current?.state === "failed" ? t("Couldn't search earlier messages")
    : hits.length === 0 ? t("No matches")
    : t(hits.length === 1 ? "{n} match" : "{n} matches", { n: hits.length });

  return (
    <div className="chat-search" role="search" aria-label={t("Search conversation")} hidden={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
      }}>
      <div className="chat-search-bar">
        <label className="chat-search-query">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">{t("Search conversation")}</span>
          <input ref={input} className="input" type="search" value={text} maxLength={SEARCH_QUERY_MAX} placeholder={t("Search conversation")}
            onChange={(event) => setText(event.target.value)} />
        </label>
        <button className="icon-button" type="button" aria-label={t("Close search")} title={t("Close search")} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
      <p className={`chat-search-status${current?.state === "failed" || paging === "failed" ? " is-error" : ""}`} role="status">{status}</p>
      {hits.length > 0 && (
        <ul className="chat-search-results">
          {hits.map((hit) => {
            const stamp = formatChatTimestamp(hit.ts, today, currentLocale(), t);
            return (
              <li key={hit.key}>
                <button type="button" className="chat-search-hit" disabled={paging === "loading"} onClick={() => onPick(hit.pick)}>
                  <span className="chat-search-meta">
                    <span className="chat-search-who">{hit.role === "user" ? t("You") : t("Agent's answer")}</span>
                    {stamp !== null && <time dateTime={hit.ts ?? undefined} title={stamp.full}>{stamp.label}</time>}
                  </span>
                  <span className="chat-search-snippet">
                    {hit.snippet.slice(0, hit.match.start)}
                    <mark>{hit.snippet.slice(hit.match.start, hit.match.start + hit.match.length)}</mark>
                    {hit.snippet.slice(hit.match.start + hit.match.length)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {current !== null && current.state !== "loading" && current.next !== null && olderKey !== null && (
        <button type="button" className="btn btn-ghost chat-search-more" onClick={() => ask(olderKey, current.next!, current.hits)}>
          {t(current.state === "failed" ? "Retry" : "Search earlier messages")}
        </button>
      )}
      {current?.state === "loading" && hits.length > 0 && <p className="chat-search-status">{t("Searching earlier messages…")}</p>}
    </div>
  );
}
