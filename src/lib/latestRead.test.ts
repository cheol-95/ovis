import { describe, expect, it } from "bun:test";
import { latestRead } from "./latestRead.ts";

// A creation dialog reads the PC's agents when it opens and again after Add another agent… installs
// one: whichever answer comes last, only the read asked for last may set the list.
describe("latestRead", () => {
  it("lets only the read asked for last apply, whatever order the answers come in", () => {
    const reads = latestRead();
    const opening = reads();
    const afterInstall = reads();
    expect(afterInstall()).toBe(true);
    expect(opening()).toBe(false);
  });

  it("lets a read apply while no later one was asked for", () => {
    const reads = latestRead();
    const only = reads();
    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });
});
