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
      // a network share on a Windows PC, however its leading separators are written
      { path: "/\\host/share/a.html" }, { path: "\\\\host\\share\\a.html" }, { path: "\\/host/share/a.html" },
      { path: "relative/a.html" }, { path: "/repo/a.svg" }, { path: "/repo/a.html\n" },
      { path: "/repo/a.html", mode: "unknown" }, { path: "/repo/a.html", title: 2 }]) {
      expect(visualizationReference(directive(data))).toBeNull();
      expect(parseMarkdown(directive(data))[0]?.type).toBe("paragraph");
    }
    expect(visualizationReference(line.slice(0, -1))).toBeNull();
    expect(visualizationReference("\uE200visualize\uE202{bad}\uE201")).toBeNull();
    expect(visualizationReference(directive({ path: "/" + "a".repeat(17_000) + ".html" }))).toBeNull();
  });
  it("draws a reference indented under a list item in that item, and the list goes on after it", () => {
    const line = directive({ path: "/repo/diagram.html" });
    const block = { type: "visualization" as const, path: "/repo/diagram.html", wide: false };
    const text = (value: string) => [{ type: "text" as const, value }];
    // lazily numbered, as agents write ordered lists: one list of two items, so the second is drawn as 2
    expect(parseMarkdown(`1. First\n   ${line}\n   More about first\n1. Second`)).toEqual([{ type: "list", ordered: true, items: [
      { content: text("First"), blocks: [block, { type: "paragraph", lines: [text("More about first")] }] },
      { content: text("Second") },
    ] }]);
    // after a blank line, two references in one item, and under a nested item
    expect(parseMarkdown(`- The flow:\n\n  ${line}\n  ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("The flow:"), blocks: [block, block] }, { content: text("Next") },
    ] }]);
    expect(parseMarkdown(`- Outer\n  - Inner\n    ${line}\n- Next`)).toEqual([{ type: "list", ordered: false, items: [
      { content: text("Outer"), blocks: [{ type: "list", ordered: false, items: [{ content: text("Inner"), blocks: [block] }] }] }, { content: text("Next") },
    ] }]);
    // not indented, it is no part of the item: it ends the list, as any block there does
    expect(parseMarkdown(`- The flow:\n${line}\n- Next`).map((each) => each.type)).toEqual(["list", "visualization", "list"]);
    for (const source of [`1. First\n   ${line}\n1. Second`, `- The flow:\n\n  ${line}\n- Next`, `- The flow:\n${line}\n- Next`]) {
      expect(JSON.stringify(parseMarkdown(source))).not.toContain("\uE200");
    }
    // an example of a reference in a list item's text is not a reference
    expect(parseMarkdown(`- The flow:\n  it reads ${line}`)).toEqual([{ type: "list", ordered: false, items: [{ content: [...text("The flow:"), ...text(" "), ...text(`it reads ${line}`)] }] }]);
  });
});
