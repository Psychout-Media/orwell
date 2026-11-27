import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** ORW-410: the PR lane plays each whole-season mix seed in its own job, then judges them together. The matrix must play exactly the guard's seeds. */
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const yml = read(".github/workflows/ci.yml");

describe("season-mix shards", () => {
  it("the shard matrix is the guard's seed list", () => {
    const seeds = read("tests/uat/wholeSeasonMixGuard.test.ts").match(/export const SEEDS = \[([^\]]*)\]/)![1];
    const shard = yml.slice(yml.indexOf("\n  season-mix-shard:\n"), yml.indexOf("\n  season-mix:\n"));
    expect(shard.match(/seed: \[([^\]]*)\]/)![1]).toBe(seeds);
  });
  it("one job judges all of them together, after every shard", () => {
    const judge = yml.slice(yml.indexOf("\n  season-mix:\n"), yml.indexOf("\n  coverage:\n"));
    expect(judge).toContain("needs: [changes, season-mix-shard]");
    expect(judge).toContain("WSMIX_FROM: .wsmix");
    expect(judge).toContain("merge-multiple: true");
  });
});
