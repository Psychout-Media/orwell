import { describe, it, expect } from "vitest";
import { dealtStringLists, SHORT_LIST_LIMIT } from "../support/poolScan";
import allowlist from "./poolGuard508.allowlist.json";

// ORW-508 static guard: a short list of strings that the engine DEALS from (a pick, a spread, an index by
// an rng draw or a hash) must not reach a player-facing field unless it is on the allowlist with a written
// reason. New short lists fail here, so the class of defect cannot grow back unseen. The pick strategy that
// replaces such a list is in the audit for ORW-508: world tables, per-person invention, entropy and memory.


describe("ORW-508 static guard: short dealt string lists", () => {
  const dealt = dealtStringLists();
  const reasons = allowlist as Record<string, string>;

  it("finds the lists it is meant to find", () => {
    const ids = dealt.map((d) => d.id);
    expect(ids).toContain("DEMEANORS");
    expect(ids).toContain("GIVEN_NAMES");
  });

  it("every dealt list shorter than the limit is on the allowlist with a written reason", () => {
    const missing = dealt.filter((d) => d.size < SHORT_LIST_LIMIT && !reasons[d.id]).map((d) => `${d.site} (${d.size})`);
    expect(missing, `new short dealt list(s): move the value to a world table, a composed deal or the writer, or add an allowlist entry with a reason`).toEqual([]);
  });

  it("the allowlist holds no stale entries and no empty reasons", () => {
    const ids = new Set(dealt.map((d) => d.id));
    const stale = Object.keys(reasons).filter((k) => !ids.has(k) || dealt.filter((d) => d.id === k).every((d) => d.size >= SHORT_LIST_LIMIT));
    expect(stale).toEqual([]);
    for (const [k, v] of Object.entries(reasons)) expect(v.length, k).toBeGreaterThan(12);
  });
});
