import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

import { useT } from "../lib/i18n.ts";
import { OUTLINE_MIN_HEADINGS, OUTLINE_READ_PX, outlineCurrent, outlineLayout, outlineListScroll, outlineStep, type OutlineLayout } from "../lib/markdownOutline.ts";

/** Every heading the renderer draws carries its Markdown level as a class (Markdown.tsx). */
const HEADINGS = ".markdown-h1, .markdown-h2, .markdown-h3, .markdown-h4, .markdown-h5, .markdown-h6";

interface Entry { readonly level: number; readonly title: string }

function levelOf(heading: HTMLElement): number {
  for (const name of heading.classList) if (/^markdown-h[1-6]$/.test(name)) return Number(name.slice(-1));
  return 2;
}

/** The heading's words as read, without the hidden MathML copy KaTeX keeps beside a formula. */
function titleOf(heading: HTMLElement): string {
  const copy = heading.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sameEntries(a: readonly Entry[], b: readonly Entry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.level === b[index]!.level && entry.title === b[index]!.title);
}

export interface MarkdownOutlineProps {
  id: string;
  /** the viewer's body: the one box the document scrolls in */
  scroller: RefObject<HTMLElement | null>;
  /** the drawer, while the contents do not fit beside the document */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** how the contents show (null: not at all), for the viewer's toggle and its layout */
  onLayout: (layout: OutlineLayout | null) => void;
}

/**
 * The contents of a rendered Markdown document (#636): its headings at their levels, one entry
 * each (a repeated title included), the one being read marked. Beside a document with room to
 * spare it is a quiet rail; otherwise a drawer over the document, opened from the viewer's header.
 * Following the reader moves only the contents' own list: never the body, never the focus.
 */
export function MarkdownOutline({ id, scroller, open, onOpenChange, onLayout }: MarkdownOutlineProps) {
  const t = useT();
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const headings = useRef<HTMLElement[]>([]);
  // a jump to a heading the body cannot bring to its top (near the end) keeps it current until the reader scrolls
  const pinned = useRef<{ index: number; scrollTop: number } | null>(null);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [layout, setLayout] = useState<OutlineLayout | null>(null);
  const drawerOpen = open && layout === "drawer";

  useLayoutEffect(() => {
    const nav = navRef.current, body = scroller.current;
    const content = nav?.parentElement ?? null;
    const root = content?.querySelector<HTMLElement>(":scope > .markdown") ?? null;
    if (nav === null || body === null || content === null || root === null) return;
    let frame = 0;
    let stale = true;
    const collect = (): void => {
      // a heading inside a closed <details> has no box to jump to
      const found = [...root.querySelectorAll<HTMLElement>(HEADINGS)].filter((heading) => heading.getClientRects().length > 0);
      headings.current = found;
      const next = found.map((heading) => ({ level: levelOf(heading), title: titleOf(heading) }));
      setEntries((previous) => sameEntries(previous, next) ? previous : next);
    };
    const measure = (): void => {
      frame = 0;
      if (stale) { stale = false; collect(); }
      const found = headings.current;
      const scrollMax = body.scrollHeight - body.clientHeight;
      // a document read at a glance (few headings, or no scrolling) has no contents
      const next = found.length >= OUTLINE_MIN_HEADINGS && scrollMax > 1 ? outlineLayout(content.clientWidth) : null;
      setLayout((previous) => previous === next ? previous : next);
      nav.style.setProperty("--outline-h", `${body.clientHeight}px`);
      const top = body.getBoundingClientRect().top;
      let reading = outlineCurrent({ tops: found.map((heading) => heading.getBoundingClientRect().top - top), viewHeight: body.clientHeight, scrollTop: body.scrollTop, scrollMax });
      const pin = pinned.current;
      if (pin !== null) {
        if (Math.abs(body.scrollTop - pin.scrollTop) <= 1 && pin.index < found.length) reading = pin.index;
        else pinned.current = null;
      }
      setCurrent((previous) => previous === reading ? previous : reading);
    };
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    // the renderer draws a long document a chunk at a time, and a <details> opens or closes
    const changed = (): void => { stale = true; schedule(); };
    const mutations = new MutationObserver(changed);
    mutations.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(body);
    sizes.observe(root);
    body.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes.disconnect();
      body.removeEventListener("scroll", schedule);
    };
  }, [scroller]);

  useEffect(() => { onLayout(layout); }, [layout, onLayout]);
  useEffect(() => () => onLayout(null), [onLayout]);

  // the entry being read stays in the middle of the list, the list stopping at its ends; only the
  // list's own scrollTop moves, so the body keeps its place and the focus stays where it is
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || layout === null || (layout === "drawer" && !open)) return;
    const entry = current === null ? null : list.children[current] as HTMLElement | undefined;
    list.scrollTop = entry === undefined || entry === null ? 0 : outlineListScroll(entry.offsetTop, entry.offsetHeight, list.clientHeight, list.scrollHeight);
  }, [current, open, layout, entries]);

  // the drawer opened: the focus goes to the entry being read; Escape, or a press outside it and its
  // toggle, closes it, Escape before the viewer's own and with the focus back on the toggle
  useLayoutEffect(() => {
    if (!drawerOpen) return;
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('[aria-current="location"]') ?? list?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const toggle = (): HTMLElement | null => document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`);
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (navRef.current?.contains(target) || toggle()?.contains(target)) return;
      onOpenChange(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      onOpenChange(false);
      toggle()?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [drawerOpen, id, onOpenChange]);

  /** The body scrolled so the heading sits at its top; the heading takes the focus, as a link's target does. */
  const jump = (index: number): void => {
    const body = scroller.current, heading = headings.current[index];
    if (!body || !heading) return;
    body.scrollTo({ top: body.scrollTop + heading.getBoundingClientRect().top - body.getBoundingClientRect().top - OUTLINE_READ_PX, behavior: "instant" });
    pinned.current = { index, scrollTop: body.scrollTop };
    setCurrent(index);
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    if (open) onOpenChange(false);
  };

  /** One stop in the Tab order (the entry being read); Up and Down, Home and End move among the entries. */
  const move = (event: KeyboardEvent<HTMLOListElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const to = outlineStep(buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, event.key);
    if (to === null) return;
    event.preventDefault();
    buttons[to]?.focus();
  };

  const shallowest = entries.reduce((least, entry) => Math.min(least, entry.level), 6);
  const stop = current ?? 0;
  return <nav ref={navRef} id={id} className={`markdown-outline markdown-outline-${layout ?? "none"}`} aria-label={t("Contents")} hidden={layout === null || (layout === "drawer" && !open)}>
    <ol ref={listRef} className="markdown-outline-list" onKeyDown={move}>
      {entries.map((entry, index) => <li key={index} data-level={entry.level} style={{ "--outline-depth": entry.level - shallowest } as CSSProperties}>
        <button type="button" tabIndex={index === stop ? 0 : -1} aria-current={index === current ? "location" : undefined} onClick={() => jump(index)}>{entry.title}</button>
      </li>)}
    </ol>
  </nav>;
}
