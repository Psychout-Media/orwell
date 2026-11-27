import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS, COMPETITION_LIBRARY_MORE, competitionById, drawCompetition } from "../../src/engine/competitionLibrary";
import { RELEVANT } from "../../src/domain/competitionOutcome";
import { FORMAT_NOUN } from "../../src/engine/competitionThemes";

/**
 * ORW-530 (Ryne 2026-11-27): the authored competition-mechanic library grows from 30 to 50 (10 HOH + 10 veto more), behind `ORWELL_COMP_MECHANICS_MORE` (ON as shipped, pinned off in the seeded test lanes until ORW-1104).
 * Pins: the sizes, unique ids across all three pools, the declared governing stat matches the resolution map, every format is nameable by the theme layer, the full-pool stat mix per phase keeps the base shape
 * (mental-dominant, physical second, social a minority), the draw with `more` off is byte-identical to the 30 pool, and with it on a season of draws never repeats. Roles only.
 */
const govs = (defs: typeof COMPETITION_LIBRARY) => defs.reduce((c, d) => { c[d.governing]++; return c; }, { physical: 0, mental: 0, social: 0 } as Record<string, number>);
describe("ORW-530 - the 20 more mechanics", () => {
  it("adds 10 HOH + 10 veto: 25 + 25 across the three pools", () => {
    for (const phase of ["hoh", "veto"] as const) {
      expect(COMPETITION_LIBRARY_MORE.filter((d) => d.phase === phase).length).toBe(10);
      expect([...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS, ...COMPETITION_LIBRARY_MORE].filter((d) => d.phase === phase).length).toBe(25);
    }
  });
  it("ids are unique across all three pools and resolve through competitionById", () => {
    const all = [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS, ...COMPETITION_LIBRARY_MORE];
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
    for (const d of COMPETITION_LIBRARY_MORE) expect(competitionById(d.id)?.id).toBe(d.id);
  });
  it("each def's governing stat is the resolution stat of its type; formats are nameable; each has a premise, three beats and a win line", () => {
    for (const d of COMPETITION_LIBRARY_MORE) {
      expect(d.governing).toBe(RELEVANT[d.type]);
      expect(FORMAT_NOUN[d.format]).toBeTruthy();
      expect(d.narrative.premise.length).toBeGreaterThan(20); expect(d.narrative.beats.length).toBe(3); expect(d.narrative.winReads.length).toBeGreaterThan(5);
    }
  });
  it("the full 50 pool keeps the base governing-stat shape per phase", () => {
    for (const phase of ["hoh", "veto"] as const) {
      const c = govs([...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS, ...COMPETITION_LIBRARY_MORE].filter((d) => d.phase === phase));
      expect(c.physical + c.mental + c.social).toBe(25);
      expect(c.mental).toBeGreaterThan(c.physical); expect(c.physical).toBeGreaterThan(c.social);
    }
  });
  it("with `more` off the draw is byte-identical to the 30 pool; with it on a 14-week season never repeats a mechanic", () => {
    const seq = (more: boolean, seed: number) => { const rng = new SeededRandom(seed), hist: string[] = []; for (let w = 1; w <= 14; w++) hist.push(drawCompetition("hoh", w, rng, hist, true, more).id); return hist; };
    for (const seed of [1, 2, 3]) {
      const rng = new SeededRandom(seed), hist: string[] = []; const old: string[] = [];
      for (let w = 1; w <= 14; w++) { const d = drawCompetition("hoh", w, rng, hist, true); hist.push(d.id); old.push(d.id); }
      expect(seq(false, seed)).toEqual(old);
      const on = seq(true, seed); expect(new Set(on).size).toBe(on.length);
    }
  });
});
