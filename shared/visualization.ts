/** A complete Codex visualization reference on its own line; malformed/streaming text stays text. */
export interface VisualizationReference {
  path: string;
  title?: string;
  wide: boolean;
}

/**
 * The largest HTML file drawn as a preview. It is the size up to which the Page renderer puts a page's own
 * files into it (server/file-view.ts EMBED_PAGE_BYTES), so a preview is the page the file viewer shows; a
 * larger file is not loaded by a reference alone, and opens in the file viewer.
 */
export const VISUALIZATION_PAGE_BYTES = 8 * 1024 * 1024;

export function visualizationReference(line: string): VisualizationReference | null {
  const value = line.trim();
  if (value.length > 16_384 || !value.startsWith("\uE200visualize\uE202") || !value.endsWith("\uE201")) return null;
  try {
    const data: unknown = JSON.parse(value.slice(11, -1));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const { path, title, mode } = data as Record<string, unknown>;
    // an absolute local path, never a network share however its two leading separators are written
    // (`//host`, `/\host`): the preview looks the file up by itself, and on a Windows PC that lookup
    // would reach out to the share
    if (typeof path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(path) || /^[\\/]{2}/.test(path)
      || /[\x00-\x1f\x7f]/.test(path) || !/\.html?$/i.test(path)
      || (mode !== undefined && mode !== "wide")
      || (title !== undefined && (typeof title !== "string" || title.length > 200))) return null;
    return { path, ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}), wide: mode === "wide" };
  } catch { return null; }
}
