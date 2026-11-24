import { describe, it, expect } from "vitest";
import { patternsFoundIn } from "../../src/composition/multiSubstring";

/** ORW-832: the one-pass multi-pattern search must say exactly what `text.includes(pattern)` says for every pattern. */
describe("ORW-832: patternsFoundIn agrees with text.includes for every pattern", () => {
  const rnd = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  it("matches includes on random texts over a small alphabet (overlaps, nesting, repeats, duplicates, empty patterns)", () => {
    const r = rnd(7);
    const word = (n: number) => Array.from({ length: n }, () => "abcé "[Math.floor(r() * 5)]).join("");
    for (let round = 0; round < 400; round++) {
      const text = word(Math.floor(r() * 300));
      const patterns = Array.from({ length: Math.floor(r() * 40) }, () => word(Math.floor(r() * 7)));
      const want = new Set(patterns.filter((p) => p && text.includes(p)));
      expect(patternsFoundIn(text, patterns)).toEqual(want);
    }
  });
  it("reports a pattern that is a suffix of another, and a pattern nested inside a longer one", () => {
    expect(patternsFoundIn("xxabcdyy", ["bcd", "cd", "d", "abcdz", "zz"])).toEqual(new Set(["bcd", "cd", "d"]));
  });
});
