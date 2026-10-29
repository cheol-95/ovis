import { describe, expect, it } from "bun:test";

import { quotePanePaths, withAttachedPaths } from "./terminalAttach.ts";

describe("quotePanePaths", () => {
  it("single-quotes each path for a POSIX shell, a quote inside closed and reopened", () => {
    expect(quotePanePaths(["/w/.ovis/a b.png", "/w/.ovis/Bob's notes.pdf"])).toBe("'/w/.ovis/a b.png' '/w/.ovis/Bob'\\''s notes.pdf'");
  });
});

describe("withAttachedPaths", () => {
  const paths = ["/w/.ovis/shot.png"];

  it("puts the quoted paths at the caret, spaced from the words on both sides", () => {
    expect(withAttachedPaths("look atplease", 7, 7, paths, 100)).toEqual({ text: "look at '/w/.ovis/shot.png' please", caret: 28 });
  });

  it("adds no space at the line's start, and one after the paths so typing goes on", () => {
    expect(withAttachedPaths("", 0, 0, paths, 100)).toEqual({ text: "'/w/.ovis/shot.png' ", caret: 20 });
  });

  it("keeps the whitespace already there instead of doubling it", () => {
    expect(withAttachedPaths("cat  | wc", 4, 4, paths, 100)).toEqual({ text: "cat '/w/.ovis/shot.png' | wc", caret: 24 });
  });

  it("replaces a selection", () => {
    expect(withAttachedPaths("open FILE now", 5, 9, paths, 100)).toEqual({ text: "open '/w/.ovis/shot.png' now", caret: 25 });
  });

  it("refuses paths that would pass the line's limit rather than cut one", () => {
    expect(withAttachedPaths("x".repeat(90), 90, 90, paths, 100)).toBeNull();
  });
});
