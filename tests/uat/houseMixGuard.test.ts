import { describe, it, expect } from "vitest";
import { playMixGame, mixShares } from "../support/houseMixDriver";

/**
 * The house-life MIX guard (ORW-551 slice 4; it replaces the old 2-seed guard `tests/unit/houseMixGuard.test.ts`, which pinned two seeds to one agreed mix).
 *
 * Why it was reworked: a two-seed, fixed-point mix check could not tell a healthy house from a flat one. It passed when every season looked the same, and a deliberate change that
 * makes seasons DIFFER (houses that lean one way or another) failed it. So the guard now reads the whole spread of 12 seeded seasons (seeds 1-12), week 1 only, player still in:
 *   1. the AVERAGE week-1 mix (bonding / strategy / gossip / conflict shares) stays within AVG_TOLERANCE points of REFERENCE;
 *   2. at least one of bonding / strategy / gossip spreads at least MIN_SPREAD points between its most and least extreme season (seasons must actually differ);
 *   3. no single season is more than MAX_DEVIATION points off REFERENCE in any category (no season goes off the rails).
 * The late game keeps its own runaway guard (`tests/property/houseMixLate.property.test.ts`, untouched).
 *
 * Heavy lane (`npm run test:heavy:house-mix`, a heavy-sims leg): 12 seasons x 350 messages is about two minutes of play (about 10 s a season), so it runs in one process.
 * ORWELL_MIX_SEEDS='3' (comma list) narrows the seeds for a local smoke run: it prints the numbers and skips the assertions (the guard needs all 12 seasons).
 * The test prints one `MIXGUARD12 {...}` line (average, spread, max deviation) so a CI log shows the real numbers.
 */

// ---- THE REFERENCE (the one constant block) ---------------------------------------------------------------------------------------------------------------------------
// Who changes it, and why: ONLY a PR that deliberately moves the week-1 house mix, with the new 12-season measurement (the MIXGUARD12 line) in its description and the
// owner's agreement. Today it is main without conviction (12-season week-1 average measured by the BDD Auditor). The conviction PR (ORW-330) replaces REFERENCE with the
// with-conviction average. The three tolerances below are the owner's numbers: never widened to make a run pass.
export const REFERENCE = { bonding: 38.0, strategy: 33.2, gossip: 22.5, conflict: 6.3 } as const;
export const AVG_TOLERANCE = 5; // points: the 12-season average, each category, against REFERENCE
export const MIN_SPREAD = 15; // points: at least one of bonding / strategy / gossip, most minus least extreme season
export const MAX_DEVIATION = 20; // points: no season, in any category, further than this from REFERENCE
// -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ALL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MESSAGES = 350;
const ADVANCE_EVERY = 6;
type Shares = { seed: number; n: number; bonding: number; strategy: number; gossip: number; conflict: number };
const CATS = ["bonding", "strategy", "gossip", "conflict"] as const;

async function playSeed(seed: number): Promise<Shares> {
  const game = await playMixGame(seed, MESSAGES, { advanceEvery: ADVANCE_EVERY });
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
  expect(rows.map((r) => r.seed).sort((a, b) => a - b), "all 12 seeded seasons are present").toEqual(ALL_SEEDS);
  for (const r of rows) expect(r.n, `season ${r.seed} has enough week-1 scenes to read a mix`).toBeGreaterThan(40);
  for (const k of CATS) expect(Math.abs(avg[k] - REFERENCE[k]), `average ${k} is ${avg[k].toFixed(1)}% against the reference ${REFERENCE[k]}%`).toBeLessThanOrEqual(AVG_TOLERANCE);
  const spreadWinner = (["bonding", "strategy", "gossip"] as const).filter((k) => spread[k] >= MIN_SPREAD);
  expect(spreadWinner.length, `seasons must differ: bonding spreads ${spread.bonding.toFixed(1)}, strategy ${spread.strategy.toFixed(1)}, gossip ${spread.gossip.toFixed(1)} points (need one at ${MIN_SPREAD}+)`).toBeGreaterThan(0);
  for (const k of CATS) expect(maxDev[k], `the most extreme season is ${maxDev[k].toFixed(1)} points off the reference ${k}`).toBeLessThanOrEqual(MAX_DEVIATION);
}

describe("house-life mix guard (12 seasons, week 1)", () => {
  const envSeeds = process.env.ORWELL_MIX_SEEDS?.split(",").map(Number).filter(Number.isFinite);
  it("plays the seasons and holds the reworked mix guard", async () => {
    const rows: Shares[] = [];
    for (const seed of envSeeds ?? ALL_SEEDS) rows.push(await playSeed(seed));
    if (envSeeds) { // local smoke run: numbers only
      for (const r of rows) console.log(`MIXGUARD12-SMOKE ${JSON.stringify({ seed: r.seed, n: r.n, b: +r.bonding.toFixed(1), s: +r.strategy.toFixed(1), g: +r.gossip.toFixed(1), c: +r.conflict.toFixed(1) })}`);
      expect(rows[0]!.n).toBeGreaterThan(0);
      return;
    }
    judge(rows);
  }, 1_200_000);
});
