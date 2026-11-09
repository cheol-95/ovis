/** A complete Codex visualization reference on its own line; malformed/streaming text stays text. */
export interface VisualizationReference {
  path: string;
  title?: string;
  wide: boolean;
}

export function visualizationReference(line: string): VisualizationReference | null {
  const value = line.trim();
  if (value.length > 16_384 || !value.startsWith("\uE200visualize\uE202") || !value.endsWith("\uE201")) return null;
  try {
    const data: unknown = JSON.parse(value.slice(11, -1));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const { path, title, mode } = data as Record<string, unknown>;
    if (typeof path !== "string" || !/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path)
      || /[\x00-\x1f\x7f]/.test(path) || !/\.html?$/i.test(path)
      || (mode !== undefined && mode !== "wide")
      || (title !== undefined && (typeof title !== "string" || title.length > 200))) return null;
    return { path, ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}), wide: mode === "wide" };
  } catch { return null; }
}
