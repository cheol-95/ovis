/**
 * Marks the terminal's bottom row with `is-at-screen-bottom` while it reaches the screen's bottom
 * edge, where its CSS keeps clear of the home indicator: the key bar (KeyBar.css), or the input
 * line with the bar folded under it (TerminalInput.css). A row stacked over another pane has that
 * pane under it, not the indicator. Measured without the room the class adds, which would
 * otherwise keep itself.
 */
export function markScreenBottom(row: HTMLElement): void {
  row.classList.remove("is-at-screen-bottom");
  row.classList.toggle("is-at-screen-bottom", row.getBoundingClientRect().bottom >= window.innerHeight - 1);
}
