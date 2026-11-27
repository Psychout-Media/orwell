import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS, COMPETITION_LIBRARY_MORE, drawCompetition, type CompetitionPhase } from "../../src/engine/competitionLibrary";

/**
 * ORW-530 - REPORT, NOT A GATE. How often does the same underlying competition MECHANIC (library id) recur, within a season and across seasons, over 200 seeded seasons of the shipped draw (`drawCompetition`, the same
 * seeded pick and the same persisted `compHistory` avoid-window the live season uses)? The premise, theme and per-round fiction are authored per competition on top of it (#1400 / ORW-509, one writer call each, with the
 * "already used" title memory); what this measures is the UNDERLYING mechanic (type + format) the engine draws, which the offline floor and the resolution both use. Two arms: the base 12 (the pre-0126 pool) and the expanded
 * pool the deploy runs (`ORWELL_COMP_MECHANICS_PLUS`, default on). Prints one table; asserts only that the report ran over the stated size.
 *   npx vitest run tests/calibration/compRecurrenceReport530.test.ts --reporter=verbose
 */
const SEASONS = 200, WEEKS = 14, PHASES: CompetitionPhase[] = ["hoh", "veto"];
type Arm = { name: string; expanded: boolean; more?: boolean };
const ARMS: Arm[] = [{ name: "base pool (12)", expanded: false }, { name: "expanded pool (30; the seeded test lanes)", expanded: true }, { name: "expanded + more (50; shipped, ORW-530)", expanded: true, more: true }];

function season(seed: number, expanded: boolean, more = false): string[] {
  const rng = new SeededRandom(seed), hist: Record<CompetitionPhase, string[]> = { hoh: [], veto: [] }, out: string[] = [];
  for (let w = 1; w <= WEEKS; w++) for (const p of PHASES) { const d = drawCompetition(p, w, rng, hist[p], expanded, more); hist[p].push(d.id); out.push(d.id); }
  return out;
}

describe("ORW-530 report: underlying mechanic recurrence over 200 seeded seasons", () => {
  it("prints within-season repeats and across-season overlap for the base and the shipped pool", () => {
    const rows: string[] = [`pool sizes: base ${COMPETITION_LIBRARY.length}, plus ${COMPETITION_LIBRARY_PLUS.length}, more ${COMPETITION_LIBRARY_MORE.length}; ${SEASONS} seasons x ${WEEKS} weeks x 2 comps = ${WEEKS * 2} draws per season`];
    for (const arm of ARMS) {
      const seasons = Array.from({ length: SEASONS }, (_, i) => season(1000 + i, arm.expanded, arm.more));
      const repeatsPer = seasons.map((s) => s.length - new Set(s).size), distinctPer = seasons.map((s) => new Set(s).size);
      const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
      let shared = 0, pairs = 0, consecShared = 0, consecPairs = 0;
      for (let i = 0; i < SEASONS; i++) for (let j = i + 1; j < SEASONS; j++) { const a = new Set(seasons[i]), b = seasons[j]!; const inter = [...new Set(b)].filter((x) => a.has(x)).length; shared += inter / new Set(b).size; pairs++; if (j === i + 1) { consecShared += inter / new Set(b).size; consecPairs++; } }
      const draws = new Map<string, number>(); for (const s of seasons) for (const id of s) draws.set(id, (draws.get(id) ?? 0) + 1);
      const top = [...draws.entries()].sort((a, b) => b[1] - a[1])[0]!, total = SEASONS * WEEKS * 2;
      rows.push(`${arm.name}: within a season ${mean(repeatsPer).toFixed(1)} repeated draws of ${WEEKS * 2} (${mean(distinctPer).toFixed(1)} distinct); the next season reuses ${(100 * consecShared / consecPairs).toFixed(0)}% of its mechanics from the one before and ${(100 * shared / pairs).toFixed(0)}% from any other; the most-drawn mechanic is ${(100 * top[1] / total).toFixed(1)}% of all draws (${top[0]})`);
    }
    console.log("COMPREPORT\n" + rows.join("\n"));
    expect(rows.length).toBe(1 + ARMS.length);
  });
});
