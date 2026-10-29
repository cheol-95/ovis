import type { ConversationTurn } from "./protocol.ts";

/** What a search may be asked for: longer queries are refused, not cut. */
export const SEARCH_QUERY_MAX = 200;

/** Words kept before and after a match in its snippet. */
const BEFORE = 60;
const AFTER = 140;

/** A match in a turn: the words around it, and where the match sits in them. */
export interface TurnMatch {
  snippet: string;
  match: { start: number; length: number };
}

/**
 * What a conversation search reads of a turn: what the user wrote, and the agent's answers. Tool
 * calls, their output, thinking and the agent's commentary between tool calls are left out, and so
 * are the turns nobody typed (notices, finished background tasks), as Codex's Find in chat does.
 */
function searchedTexts(turn: ConversationTurn): string[] {
  return turn.parts.flatMap((part) => part.kind === "text" && part.phase !== "commentary" ? [part.text] : []);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squeeze = (text: string): string => text.replace(/\s+/g, " ");

/** The first case-insensitive match of `query` in the turn's searched text, or null. */
export function matchTurn(turn: ConversationTurn, query: string): TurnMatch | null {
  // a regular expression keeps the match's place in the text itself, which lowercasing can shift
  const pattern = new RegExp(escapeRegExp(query), "iu");
  for (const text of searchedTexts(turn)) {
    const found = pattern.exec(text);
    if (found === null) continue;
    const at = found.index, end = at + found[0].length;
    let from = Math.max(0, at - BEFORE), to = Math.min(text.length, end + AFTER);
    // a cut starts and ends on a word, where there is one near
    if (from > 0) { const space = text.indexOf(" ", from); if (space !== -1 && space < at) from = space + 1; }
    if (to < text.length) { const space = text.lastIndexOf(" ", to); if (space > end) to = space; }
    const head = `${from > 0 ? "…" : ""}${squeeze(text.slice(from, at)).trimStart()}`;
    const hit = squeeze(found[0]);
    const tail = `${squeeze(text.slice(end, to)).trimEnd()}${to < text.length ? "…" : ""}`;
    return { snippet: `${head}${hit}${tail}`, match: { start: head.length, length: hit.length } };
  }
  return null;
}
