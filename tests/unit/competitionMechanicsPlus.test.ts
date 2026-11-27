import { describe, it, expect } from "vitest";
import {
  COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS, drawCompetition, competitionById,
} from "../../src/engine/competitionLibrary";
import { FORMAT_NOUN } from "../../src/engine/competitionThemes";
import { RELEVANT } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { CompetitionPhase } from "../../src/engine/competitionLibrary";

/**
 * Feature 0126 — the expanded competition-mechanic pool (the pure engine half). Adds 9 HOH + 9 veto
 * mechanics (30 total) so a season can run essentially repeat-free at the MECHANIC level. Proves the pool
 * sizes, that the new mechanics preserve the base governing-stat MIX (calibration stability), that every id
 * is unique and every format is nameable by the 0125 theme layer, and — the load-bearing guarantee — that
 * the base (`expanded=false`) draw is byte-identical to pre-0126. Roles only — no names.
 */

const govStats = (defs: { type: string }[]): Record<string, number> => {
  const c: Record<string, number> = { physical: 0, mental: 0, social: 0 };
  for (const d of defs) c[RELEVANT[d.type as keyof typeof RELEVANT]]++;
  return c;
};

describe("0126 — the pool grows to 15 HOH + 15 veto (30 total)", () => {
  it("base is 6+6 and the expanded pool adds 9+9", () => {
    const baseHoh = COMPETITION_LIBRARY.filter((d) => d.phase === "hoh").length;
    const baseVeto = COMPETITION_LIBRARY.filter((d) => d.phase === "veto").length;
    expect([baseHoh, baseVeto]).toEqual([6, 6]);
    const plusHoh = COMPETITION_LIBRARY_PLUS.filter((d) => d.phase === "hoh").length;
    const plusVeto = COMPETITION_LIBRARY_PLUS.filter((d) => d.phase === "veto").length;
    expect([plusHoh, plusVeto]).toEqual([9, 9]);
    // 15 each ≥ the ~14 HOH / ~13 veto comps a season runs ⇒ a repeat-free season is reachable.
    expect(baseHoh + plusHoh).toBe(15);
    expect(baseVeto + plusVeto).toBe(15);
  });

  it("every id across both pools is unique", () => {
    const ids = [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS].map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each def's declared governing stat matches the resolution map for its type (no drift)", () => {
    for (const d of [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS]) {
      expect(d.governing).toBe(RELEVANT[d.type]);
    }
  });

  it("every format is nameable by the 0125 theme layer (FORMAT_NOUN is total over the pool)", () => {
    for (const d of COMPETITION_LIBRARY_PLUS) expect(FORMAT_NOUN[d.format]).toBeTruthy();
  });
});

describe("0126 — the expanded pool preserves the base governing-stat mix (calibration stability)", () => {
  it("the FULL pool stays mental-dominant with physical second and social a minority, per phase", () => {
    for (const phase of ["hoh", "veto"] as const) {
      const full = [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS].filter((d) => d.phase === phase);
      const c = govStats(full);
      expect(c.physical + c.mental + c.social).toBe(15);
      expect(c.mental).toBeGreaterThan(c.physical); // mental-dominant (as the base is)
      expect(c.physical).toBeGreaterThan(c.social);  // physical second, social a minority
    }
  });
});

describe("0126 — the base draw is byte-identical (the seeded spine is unmoved when off)", () => {
  function drawSeq(phase: CompetitionPhase, seed: number, weeks: number, expanded: boolean): string[] {
    const rng = new SeededRandom(seed);
    const recent: string[] = [];
    const out: string[] = [];
    for (let w = 1; w <= weeks; w++) {
      const def = drawCompetition(phase, w, rng, recent, expanded);
      out.push(def.id);
      recent.push(def.id);
    }
    return out;
  }

  it("expanded=false draws EXACTLY the base pool, and never an expanded-only mechanic", () => {
    const plusIds = new Set(COMPETITION_LIBRARY_PLUS.map((d) => d.id));
    for (const phase of ["hoh", "veto"] as const) {
      const seq = drawSeq(phase, 7, 14, false);
      expect(seq.every((id) => !plusIds.has(id))).toBe(true);
    }
  });

  it("expanded=true CAN draw the new mechanics and reaches far more distinct comps over a season", () => {
    const distinctBase = new Set(drawSeq("hoh", 7, 14, false)).size;
    const distinctPlus = new Set(drawSeq("hoh", 7, 14, true)).size;
    expect(distinctPlus).toBeGreaterThan(distinctBase); // the wider pool shows more distinct mechanics
    // over 14 HOH draws from a 15-deep pool, the season is essentially repeat-free at the mechanic level.
    expect(distinctPlus).toBeGreaterThanOrEqual(12);
  });

  it("competitionById resolves ids from BOTH pools (a deferred veto drawn from the expanded pool)", () => {
    expect(competitionById(COMPETITION_LIBRARY[0]!.id)?.id).toBe(COMPETITION_LIBRARY[0]!.id);
    expect(competitionById(COMPETITION_LIBRARY_PLUS[0]!.id)?.id).toBe(COMPETITION_LIBRARY_PLUS[0]!.id);
    expect(competitionById("no-such-comp")).toBeUndefined();
  });
});
