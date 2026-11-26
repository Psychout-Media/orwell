import { describe, it, expect } from "vitest";
import { playMixGame, mixShares } from "../support/houseMixDriver";
import { socialBroken, seasonsIdentical } from "../support/brokenBounds";

/**
 * The house-life MIX guard (ORW-551 slice 4; it replaces the old 2-seed guard `tests/unit/houseMixGuard.test.ts`, which pinned two seeds to one agreed mix).
 *
 * Why it was reworked: a two-seed, fixed-point mix check could not tell a healthy house from a flat one. It passed when every season looked the same, and a deliberate change that
 * makes seasons DIFFER (houses that lean one way or another) failed it. So the guard now reads the whole spread of 12 seeded seasons (seeds 1-12), week 1 only, player still in:
 *   1. the AVERAGE week-1 mix (bonding / strategy / gossip / conflict shares) stays within AVG_TOLERANCE points of REFERENCE;
 *   2. at least one of bonding / strategy / gossip spreads at least MIN_SPREAD points between its most and least extreme season (seasons must actually differ);
 *   3. no single season is more than MAX_DEVIATION points off REFERENCE in any category (no season goes off the rails).
 * ORW-991 (Ryne 2026-11-26: social balance is tracked weekly, not held per fix): those three are now a REPORT (printed as MIXGUARD12-REPORT, tracked weekly). The build fails only when
 * the mix is BROKEN (tests/support/brokenBounds.ts): a kind of scene gone or over 75% in the average week 1, any season's week 1 likewise, or every season the same mix.
 * The late game keeps its own runaway guard (`tests/property/houseMixLate.property.test.ts`, untouched).
 *
 * Heavy lane (`npm run test:heavy:house-mix`, a heavy-sims leg): 12 seasons of full week-1 play (until week 2 begins), so it runs in one process.
 * ORWELL_MIX_SEEDS='3' (comma list) narrows the seeds for a local smoke run: it prints the numbers and skips the assertions (the guard needs all 12 seasons).
 * The test prints one `MIXGUARD12 {...}` line (average, spread, max deviation) so a CI log shows the real numbers.
 */

// ---- THE REFERENCE (the one constant block) ---------------------------------------------------------------------------------------------------------------------------
// Who changes it, and why: ONLY a PR that deliberately moves the week-1 house mix, with the new 12-season measurement (the MIXGUARD12 line) in its description and the
// owner's agreement. Today it is the with-conviction average (0160 / ORW-330, Ryne 2026-11-16: "Yeah, I think that type of check is great", the reference being today's average
// with conviction), measured by this guard on conviction + ORW-550's comp-round hours (#2904): 36.5 / 32.3 / 25.1 / 6.1 over 3092 week-1 scenes
// (conviction alone was 38.0 / 32.1 / 23.9 / 6.1; #2904 alone 36.7 / 33.7 / 23.5 / 6.0; main before both 38.0 / 33.2 / 22.5 / 6.3).
// ORW-539 / 0163 (perceived bonds, #2909) re-measured on top: 35.0 / 34.1 / 24.4 / 6.5 over 3121 week-1 scenes (the HOH reads pairs from what they saw, so a little more strategy).
// The three tolerances below are the owner's numbers: never widened to make a run pass.
// ORW-568 (Theme 3 slice 4, bond feelings) re-baselined the pin: homophily (0176), territory (0176 part 2), the veto-day pacing (ORW-565), mood contagion (0185) and bond feelings
// moved the week-1 mix; main + this change measured by this guard: 33.2 / 34.0 / 26.0 / 6.8 over 3181 week-1 scenes (main alone, Auditor, f2ba4f19a: 33.2 / 33.6 / 27.0 / 6.2 over 3303).
// ORW-571 (goals no longer fade on a nightly timer while they are being served) deliberately moved the week-1 mix: a served goal keeps acting, so more bonding and a little less gossip;
// main + this change measured by this guard: 36.7 / 33.5 / 23.8 / 6.0 over 3046 week-1 scenes (was 33.2 / 34.0 / 26.0 / 6.8, 12-season, main + bond feelings + jealousy).
// ORW-653 (0205, meet the cast) re-baselined the pin on top of the tour (0206, ORW-654), leverage plays (0202) and the bed rush (0201): the week-1 house is a little gossipier and a
// little less strategic. Ryne (relayed by the Coordinator, 2026-11-18): "a gossipy house is fine". main + this change measured by this guard: 35.0 / 31.4 / 28.4 / 5.2 over 3046
// week-1 scenes (the ORW-571 reference was 36.7 / 33.5 / 23.8 / 6.0, so the cumulative drift is bonding -1.7, strategy -2.1, gossip +4.6, conflict -0.8; without a new reference gossip sat 4.6 off, too close to the tolerance for the next slice).
// ORW-651 (0209, the habits system) and the work merged since re-baselined the pin (Ryne, 2026-11-18: the habits mix shift is "fine for now"; no retune): routines pull people to their
// places, so less free mingling and more time spent scheming with whoever is there. main measured by this guard (ORW-664 does not move it: a fresh-character harness): 30.2 / 34.7 / 28.5 / 6.7
// over 2974 week-1 scenes (the previous reference, set with meet-the-cast, was 35.0 / 31.4 / 28.4 / 5.2: so bonding -4.8, strategy +3.3, gossip +0.1, conflict +1.5; the ORW-571 reference was 36.7 / 33.5 / 23.8 / 6.0).
export const REFERENCE = { bonding: 30.2, strategy: 34.7, gossip: 28.5, conflict: 6.7 } as const;
export const AVG_TOLERANCE = 5; // points: the 12-season average, each category, against REFERENCE
export const MIN_SPREAD = 15; // points: at least one of bonding / strategy / gossip, most minus least extreme season
export const MAX_DEVIATION = 25; // points: no season, in any category, further than this from REFERENCE. 20 was proposed; 25 chosen (Coordinator) because 1 of 12 healthy seasons on main is 22 off (seed 9 strategy); still catches a dead or runaway season
// -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ALL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MESSAGES = 1500; // generous cap: play stops as soon as week 2 begins (stopAtWeek), so week 1 is played to completion
const ADVANCE_EVERY = 6;
type Shares = { seed: number; n: number; bonding: number; strategy: number; gossip: number; conflict: number };
const CATS = ["bonding", "strategy", "gossip", "conflict"] as const;

async function playSeed(seed: number): Promise<Shares> {
  const game = await playMixGame(seed, MESSAGES, { advanceEvery: ADVANCE_EVERY, stopAtWeek: 2 });
  const s = mixShares(game.scenes.filter((x) => x.week === 1 && !x.playerOut));
  return { seed, ...s };
}

function judge(rows: Shares[]): void {
  const avg = {} as Record<(typeof CATS)[number], number>;
  const spread = {} as Record<(typeof CATS)[number], number>;
  const maxDev = {} as Record<(typeof CATS)[number], number>;
  for (const k of CATS) {
    const v = rows.map((r) => r[k]);
    avg[k] = v.reduce((a, b) => a + b, 0) / v.length;
    spread[k] = Math.max(...v) - Math.min(...v);
    maxDev[k] = Math.max(...v.map((x) => Math.abs(x - REFERENCE[k])));
  }
  const r1 = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(1)]));
  console.log(`MIXGUARD12 ${JSON.stringify({ seasons: rows.length, scenes: rows.reduce((a, r) => a + r.n, 0), avg: r1(avg), spread: r1(spread), maxDev: r1(maxDev), reference: REFERENCE })}`);
  console.log(`MIXGUARD12-SEEDS ${JSON.stringify(rows.map((r) => ({ seed: r.seed, n: r.n, ...r1({ b: r.bonding, s: r.strategy, g: r.gossip, c: r.conflict }) })))}`);
  for (const r of rows) console.log(`MIXGUARD12-SEEDS ${r.seed}: ${r.bonding.toFixed(1)}/${r.strategy.toFixed(1)}/${r.gossip.toFixed(1)}/${r.conflict.toFixed(1)} n${r.n}`);
  expect(rows.map((r) => r.seed).sort((a, b) => a - b), "all 12 seeded seasons are present").toEqual(ALL_SEEDS);
  for (const r of rows) expect(r.n, `season ${r.seed} has enough week-1 scenes to read a mix`).toBeGreaterThan(40);
  // the report (never fails): the agreed reference, tolerance, spread and deviation
  const report = [
    ...CATS.filter((k) => Math.abs(avg[k] - REFERENCE[k]) > AVG_TOLERANCE).map((k) => `average ${k} ${avg[k].toFixed(1)}% is more than ${AVG_TOLERANCE} off the reference ${REFERENCE[k]}%`),
    ...((["bonding", "strategy", "gossip"] as const).some((k) => spread[k] >= MIN_SPREAD) ? [] : [`no kind spreads ${MIN_SPREAD}+ points across the seasons`]),
    ...CATS.filter((k) => maxDev[k] > MAX_DEVIATION).map((k) => `the most extreme season is ${maxDev[k].toFixed(1)} points off the reference ${k}`),
  ];
  console.log(`MIXGUARD12-REPORT ${report.length ? report.join("; ") : "all within the agreed reference"}`);
  // the build fails only on a broken mix
  const broken = [
    ...socialBroken({ "week 1 average": { n: rows.reduce((a, r) => a + r.n, 0), ...avg } }, 40),
    ...rows.flatMap((r) => socialBroken({ [`season ${r.seed} week 1`]: r }, 40)),
    ...seasonsIdentical(spread),
  ];
  expect(broken, "the week-1 house-life mix is broken").toEqual([]);
}

describe("house-life mix guard (12 seasons, week 1)", () => {
  const envSeeds = process.env.ORWELL_MIX_SEEDS?.split(",").map(Number).filter(Number.isFinite);
  it("plays the seasons; fails only on a broken mix (the agreed reference is a report)", async () => {
    const rows: Shares[] = [];
    for (const seed of envSeeds ?? ALL_SEEDS) rows.push(await playSeed(seed));
    if (envSeeds) { // local smoke run: numbers only
      for (const r of rows) console.log(`MIXGUARD12-SEEDS ${r.seed}: ${r.bonding.toFixed(1)}/${r.strategy.toFixed(1)}/${r.gossip.toFixed(1)}/${r.conflict.toFixed(1)} n${r.n}`);
      expect(rows[0]!.n).toBeGreaterThan(0);
      return;
    }
    judge(rows);
  }, 1_200_000);
});
