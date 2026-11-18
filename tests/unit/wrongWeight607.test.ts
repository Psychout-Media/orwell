import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { freshness, halfLifeFor, wrongWeight, easedShareOf, GRUDGES, type GrudgeRow } from "../../src/engine/grudges";

/** ORW-607 (wrongs, step 1): ONE freshness curve for a wrong; every grudge reader weighs through it. Roles only. */
const row = (o: Partial<GrudgeRow> = {}): GrudgeRow => ({ kind: "lied-to", week: 2, day: 1, severity: 0.6, peak: 0.6, eased: 0, refKey: "r", ...o });
const dialsOf = [{}, { loyalty: 1.2, paranoia: 0.9 }, { keeper: true, ease: 1.3 }];

describe("wrongWeight, the one curve", () => {
  it("is exactly freshness x severity at the holder's half-life, byte for byte", () => {
    for (const d of dialsOf) for (const w of [2, 5, 9, 30]) {
      const r = row({ eased: 0.1 });
      const life = halfLifeFor(d) / ((d as { ease?: number }).ease ?? 1);
      expect(wrongWeight(r, w, d)).toBe(freshness(r, w, life) * r.severity);
    }
  });
  it("with no dials equals the neutral default curve the HOH-room read used", () => {
    const r = row();
    expect(wrongWeight(r, 9)).toBe(r.severity * freshness(r, 9));
  });
  it("fades monotonically with the weeks and is never zero", () => {
    const r = row();
    let prev = Infinity;
    for (let w = 2; w < 80; w++) { const x = wrongWeight(r, w); expect(x).toBeLessThanOrEqual(prev); expect(x).toBeGreaterThan(0); prev = x; }
    expect(wrongWeight(r, 500)).toBeGreaterThanOrEqual(GRUDGES.FLOOR_SHARE * r.peak * r.severity - 1e-12);
  });
  it("repair lowers it, never below the floor", () => {
    const fresh = wrongWeight(row(), 4);
    const mended = wrongWeight(row({ eased: GRUDGES.EASE_CAP * 0.6 }), 4);
    expect(mended).toBeLessThan(fresh);
    expect(mended).toBeGreaterThan(0);
    expect(easedShareOf(row({ eased: 99 }))).toBe(GRUDGES.EASE_CAP);
  });
  it("a longer-memory holder weighs the same wrong heavier", () => {
    expect(wrongWeight(row(), 12, { keeper: true })).toBeGreaterThan(wrongWeight(row(), 12));
  });
});

describe("the consumers read the one curve (source pin)", () => {
  const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
  it("the revenge fold, the bitter juror and the HOH room take their weight from wrongWeight / the book's weight, not their own freshness x severity", () => {
    expect(src).toContain("combineSalience(memory, g.weight, dial)");
    expect(src).toContain("JURY_GRUDGE.scale * g.weight");
    expect(src).toContain("wrongWeight(row, s.week)");
    expect(src).toContain("weight: wrongWeight(row, this.live.week, dials)");
    expect(src).not.toMatch(/g\.freshness \* g\.severity/);
    expect(src).not.toMatch(/row\.severity \* grudgeFreshness/);
    expect(src).not.toMatch(/row\.eased \/ row\.peak/);
  });
});
