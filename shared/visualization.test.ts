import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./markdown.ts";
import { visualizationReference } from "./visualization.ts";

const directive = (data: unknown) => `\uE200visualize\uE202${JSON.stringify(data)}\uE201`;

describe("Codex visualization references", () => {
  it("recognizes an absolute HTML file, metadata and Windows paths as a block between prose", () => {
    const line = directive({ path: "/repo/도식 with spaces.html", mode: "wide", title: " Before / After " });
    expect(parseMarkdown(`Before\n${line}\nAfter`)).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "Before" }]] },
      { type: "visualization", path: "/repo/도식 with spaces.html", title: "Before / After", wide: true },
      { type: "paragraph", lines: [[{ type: "text", value: "After" }]] },
    ]);
    expect(visualizationReference(directive({ path: "C:\\work\\diagram.HTM" }))).toEqual({ path: "C:\\work\\diagram.HTM", wide: false });
  });
  it("leaves fenced/inline examples, unfinished JSON and unsupported targets as text", () => {
    const line = directive({ path: "/repo/diagram.html" });
    expect(parseMarkdown(`\`\`\`text\n${line}\n\`\`\``)[0]?.type).toBe("code");
    expect(parseMarkdown(`Example: ${line}`)[0]?.type).toBe("paragraph");
    for (const data of [null, [], { path: "https://example.org/a.html" }, { path: "//host/a.html" },
      { path: "relative/a.html" }, { path: "/repo/a.svg" }, { path: "/repo/a.html\n" },
      { path: "/repo/a.html", mode: "unknown" }, { path: "/repo/a.html", title: 2 }]) {
      expect(visualizationReference(directive(data))).toBeNull();
      expect(parseMarkdown(directive(data))[0]?.type).toBe("paragraph");
    }
    expect(visualizationReference(line.slice(0, -1))).toBeNull();
    expect(visualizationReference("\uE200visualize\uE202{bad}\uE201")).toBeNull();
    expect(visualizationReference(directive({ path: "/" + "a".repeat(17_000) + ".html" }))).toBeNull();
  });
});
