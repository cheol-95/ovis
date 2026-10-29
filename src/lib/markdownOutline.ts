/**
 * The contents of a rendered Markdown document (#636): which heading is being read, where the
 * contents' own list scrolls to keep it in view, and whether the contents fit beside the document.
 * Measured in the browser by `components/MarkdownOutline.tsx`; plain numbers here.
 */

/** Fewer headings than this read at a glance: the contents stay out. */
export const OUTLINE_MIN_HEADINGS = 2;
/** The rail's column beside the document: below this it is not drawn there. */
export const OUTLINE_RAIL_PX = 200;
/** The narrowest document the rail leaves room for; a narrower viewer opens the contents as a drawer. */
export const OUTLINE_DOC_MIN_PX = 560;
/** How far under the body's top edge a heading counts as reached, and where a jump puts it. */
export const OUTLINE_READ_PX = 12;

export type OutlineLayout = "rail" | "drawer";

/** A rail beside the document when the viewer's content is wide enough for both, else a drawer over it. */
export function outlineLayout(contentWidth: number): OutlineLayout {
  return contentWidth >= OUTLINE_RAIL_PX + OUTLINE_DOC_MIN_PX ? "rail" : "drawer";
}

export interface OutlineView {
  /** each heading's top, measured from the body's top edge (negative above it) */
  readonly tops: readonly number[];
  readonly viewHeight: number;
  readonly scrollTop: number;
  /** scrollHeight − clientHeight */
  readonly scrollMax: number;
}

/**
 * The heading being read: the last one at or above the reading line, null above the first. The
 * line sits near the top of the body, and over the last screen of the document it slides to the
 * bottom edge, so a short last section (which can never reach the top) still becomes current once
 * the body is scrolled to its end.
 */
export function outlineCurrent({ tops, viewHeight, scrollTop, scrollMax }: OutlineView): number | null {
  const span = Math.min(viewHeight, scrollMax);
  const toEnd = span > 0 ? Math.max(0, Math.min(1, 1 - (scrollMax - scrollTop) / span)) : 0;
  const line = OUTLINE_READ_PX + (viewHeight - OUTLINE_READ_PX) * toEnd;
  let current: number | null = null;
  for (const [index, top] of tops.entries()) {
    if (top > line + 0.5) break;
    current = index;
  }
  return current;
}

/**
 * The list's scrollTop that puts an entry in its middle, kept within the list's scroll range so
 * the first and last entries stop at its ends. `entryTop` is the entry's offset in the list's content.
 */
export function outlineListScroll(entryTop: number, entryHeight: number, listHeight: number, listScrollHeight: number): number {
  const centred = entryTop + entryHeight / 2 - listHeight / 2;
  return Math.round(Math.max(0, Math.min(listScrollHeight - listHeight, centred)));
}

/** Up and Down, Home and End move among the entries; anything else is not the list's. */
export function outlineStep(from: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowUp": return Math.max(0, from - 1);
    case "ArrowDown": return Math.min(count - 1, from + 1);
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
