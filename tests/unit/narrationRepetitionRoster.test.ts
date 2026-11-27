/** ORW-510: the repetition probe says so when its --save / --roster file names no houseguest, instead of printing per-houseguest counts of 0 that read as a clean result. Roles only. */
import { describe, expect, it } from "vitest";
import { rosterWarning } from "../../scripts/probes/narrationRepetition";

describe("narrationRepetition roster warning (ORW-510)", () => {
  it("warns when a --save file names no houseguest, and points at --roster", () => {
    const w = rosterWarning("--save", 0);
    expect(w).toMatch(/NOT measured/);
    expect(w).toMatch(/--roster/);
  });
  it("warns when a --roster file names no houseguest", () => {
    expect(rosterWarning("--roster", 0)).toMatch(/NOT measured/);
  });
  it("only notes the missing roster when neither flag is given", () => {
    expect(rosterWarning(null, 0)).toMatch(/^note:/);
  });
  it("says nothing when names loaded", () => {
    expect(rosterWarning("--save", 16)).toBeNull();
    expect(rosterWarning("--roster", 3)).toBeNull();
  });
});
