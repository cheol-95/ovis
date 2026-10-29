import { describe, expect, it } from "bun:test";
import { OUTLINE_DOC_MIN_PX, OUTLINE_RAIL_PX, OUTLINE_READ_PX, outlineCurrent, outlineLayout, outlineListScroll, outlineStep } from "./markdownOutline.ts";

describe("outlineCurrent", () => {
  const view = { viewHeight: 800, scrollMax: 5_000 };

  it("is null above the first heading and the last heading reached after it", () => {
    expect(outlineCurrent({ ...view, tops: [100, 900, 1_700], scrollTop: 0 })).toBeNull();
    expect(outlineCurrent({ ...view, tops: [OUTLINE_READ_PX, 900, 1_700], scrollTop: 0 })).toBe(0);
    expect(outlineCurrent({ ...view, tops: [-900, -40, 300], scrollTop: 2_000 })).toBe(1);
  });

  it("keeps a repeated title apart: the entry is the heading's position, not its words", () => {
    expect(outlineCurrent({ ...view, tops: [-500, -20, 400, 2_000], scrollTop: 1_000 })).toBe(1);
  });

  it("makes a short last section current once the body is scrolled to its end", () => {
    // the last two headings sit low on the last screen and can never reach the top
    const tops = [-1_200, 500, 700];
    expect(outlineCurrent({ ...view, tops, scrollTop: 5_000 })).toBe(2);
    // a screen before the end, the reading line is back at the top
    expect(outlineCurrent({ ...view, tops, scrollTop: 4_200 })).toBe(0);
  });

  it("starts at the top of a document only a little taller than the body", () => {
    expect(outlineCurrent({ viewHeight: 800, scrollMax: 100, tops: [0, 300, 700], scrollTop: 0 })).toBe(0);
    expect(outlineCurrent({ viewHeight: 800, scrollMax: 100, tops: [-100, 200, 600], scrollTop: 100 })).toBe(2);
  });
});

describe("outlineListScroll", () => {
  it("puts the entry in the middle of the list", () => {
    expect(outlineListScroll(1_000, 28, 600, 3_000)).toBe(714);
  });

  it("stops at the list's ends", () => {
    expect(outlineListScroll(40, 28, 600, 3_000)).toBe(0);
    expect(outlineListScroll(2_960, 28, 600, 3_000)).toBe(2_400);
    expect(outlineListScroll(100, 28, 600, 500)).toBe(0);
  });
});

describe("outlineLayout", () => {
  it("draws the rail only beside a document of readable width", () => {
    expect(outlineLayout(OUTLINE_RAIL_PX + OUTLINE_DOC_MIN_PX)).toBe("rail");
    expect(outlineLayout(OUTLINE_RAIL_PX + OUTLINE_DOC_MIN_PX - 1)).toBe("drawer");
    expect(outlineLayout(366)).toBe("drawer");
  });
});

describe("outlineStep", () => {
  it("moves within the entries", () => {
    expect(outlineStep(0, 5, "ArrowUp")).toBe(0);
    expect(outlineStep(2, 5, "ArrowDown")).toBe(3);
    expect(outlineStep(4, 5, "ArrowDown")).toBe(4);
    expect(outlineStep(3, 5, "Home")).toBe(0);
    expect(outlineStep(0, 5, "End")).toBe(4);
    expect(outlineStep(0, 5, "Enter")).toBeNull();
    expect(outlineStep(0, 0, "ArrowDown")).toBeNull();
  });
});
