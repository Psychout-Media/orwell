import { describe, it, expect } from "vitest";
import ratchet from "./fixtures/worldPoolRecurrence.json";
import { buildRows } from "../../scripts/probes/worldPoolMeasure";

// ORW-509 recurrence ratchet for the non-character world lists (competition names and worlds, house events, alliance names, stock lines). The measurement code is the
// same file the PR's before/after table comes from. A list that repeats more than its ceiling, or has fewer distinct values than its floor, fails.
// This also holds the product rule as a test: a season's competitions, house and event flavour are not shared with the previous season's beyond a set rate.

const rows = buildRows(ratchet.seasons);
const byList = new Map(rows.map((r) => [r.list, r]));

describe("ORW-509 recurrence ratchet (world lists)", () => {
  for (const [list, c] of Object.entries(ratchet.lists)) {
    it(`${list}: repeats within a season <= ${c.maxWithin}, >= ${c.minAcross} distinct across seasons, next-season share <= ${c.maxNext}`, () => {
      const r = byList.get(list);
      expect(r, `the probe measures "${list}"`).toBeDefined();
      expect(r!.within).toBeLessThanOrEqual(c.maxWithin);
      expect(r!.across).toBeGreaterThanOrEqual(c.minAcross);
      expect(r!.next).toBeLessThanOrEqual(c.maxNext);
    });
  }

  it("a season's competitions, house and event flavour are not shared with the previous season's beyond a set rate", () => {
    const share = (l: string): number => byList.get(l)!.next;
    expect(share("competition names (themed)")).toBeLessThanOrEqual(0.03);
    expect(share("competition scene-setter + premise")).toBeLessThanOrEqual(0.03);
    expect(share("house-event lines")).toBeLessThanOrEqual(0.01);
    expect(share("alliance names")).toBeLessThanOrEqual(0.02);
    // With the previous season's picks handed in as `avoid`, nothing is shared at all (the install's ledger does this in play).
    expect(share("competition themes (worlds) WITH memory")).toBe(0);
    expect(share("alliance names WITH memory")).toBe(0);
    expect(share("house theme WITH memory")).toBe(0);
  });

  it("every list the probe measures is either ratcheted or named in `open` with a reason", () => {
    const named = new Set([...Object.keys(ratchet.lists), "competition mechanics", "house theme (id)", "house room names", "tie natures"]);
    for (const r of rows) expect(named.has(r.list), `${r.list} needs a ratchet entry or an "open" reason`).toBe(true);
    for (const k of ["competition mechanics", "house theme (id)", "house room names", "tie natures"]) expect(Object.keys(ratchet.open)).toContain(k);
  });
});
