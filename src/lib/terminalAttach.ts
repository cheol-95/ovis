/**
 * The paths of files uploaded beside a pane, as the terminal takes them: each single-quoted for a
 * POSIX shell (a quote inside closed, escaped and reopened), separated by a space. A drop, a paste
 * of files and the Attach control all type them this way (useTerminalMount.ts, TerminalInput.tsx).
 */
export function quotePanePaths(paths: readonly string[]): string {
  return paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
}

/**
 * The input line's draft with the quoted paths in place of its selection (or at its caret), set
 * apart by one space from the words on either side, and the caret after them and that space so
 * typing goes on. Null when the result would pass `limit` characters: a cut path would name
 * another file, so nothing is put in.
 */
export function withAttachedPaths(draft: string, start: number, end: number, paths: readonly string[], limit: number): { text: string; caret: number } | null {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = /^\s/.test(after) ? "" : " ";
  const text = `${before}${lead}${quotePanePaths(paths)}${trail}${after}`;
  if (text.length > limit) return null;
  return { text, caret: before.length + lead.length + quotePanePaths(paths).length + 1 };
}
