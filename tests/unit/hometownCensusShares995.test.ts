import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import { WORLD_PLACES, type SizeClass } from "../../src/engine/data/worldPlaces";
import { HOMETOWN_FLATTEN, stateCap } from "../../src/engine/data/worldHometowns";
import { buildTable, drawOne } from "../../src/engine/data/worldSampler";
import { emptyLedger, recordSeason, avoidSets, factsOfCast } from "../../src/domain/recentSeasons";

/**
 * ORW-995: where the cast's hometowns land, end to end (every filter, cap and the recent-seasons memory on),
 * against where Americans live in the same table (Census 2023, incorporated places of 1,000 or more).
 *
 * CASTS = 300 seeded casts of 15 = 4,500 draws, each cast avoiding the previous six seasons (as production does).
 * Noise: the standard error of a share p over 4,500 independent draws is sqrt(p(1-p)/4500), 0.5 to 0.7 points
 * for a size class and 0.3 to 0.5 for a big state; the caps make draws within a cast depend on each other, and
 * the three seed sets below differ from each other by up to about 1.5 points. Tolerances sit at about 3x that.
 *   size class: +-4.0 points of share
 *   state:      +-3.0 points for the eight largest states (above 2.9% of residents each)
 * Measured before the fix (flatten 0.85, flat caps, memory blocks big cities): big city 10.8 against 21.6
 * (-10.8), town 34.0 against 24.0 (+10.0), California 11.4 against 15.7 (-4.3): outside both tolerances.
 */
const CASTS = 300;
const SIZE_TOL = 4.0;
const STATE_TOL = 3.0;

const placeOf = new Map(WORLD_PLACES.map((p) => [p.city, p]));
const TOTAL = WORLD_PLACES.reduce((a, p) => a + p.popK, 0);
const CENSUS_SIZE: Record<string, number> = {};
const CENSUS_STATE: Record<string, number> = {};
for (const p of WORLD_PLACES) {
  CENSUS_SIZE[p.size] = (CENSUS_SIZE[p.size] ?? 0) + (100 * p.popK) / TOTAL;
  CENSUS_STATE[p.state] = (CENSUS_STATE[p.state] ?? 0) + (100 * p.popK) / TOTAL;
}
const TOP_STATES = Object.entries(CENSUS_STATE).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
const SIZES: SizeClass[] = ["big-city", "city", "small-city", "town"];

function measure(seed0: number, casts: number) {
  const size: Record<string, number> = {}, state: Record<string, number> = {};
  let n = 0, offTable = 0, ledger = emptyLedger();
  for (let i = 0; i < casts; i++) {
    const { npcs } = generateHouse(new SeededRandom(seed0 + i * 7919), undefined, avoidSets(ledger));
    for (const h of npcs) {
      const p = placeOf.get(h.character.hometown!);
      if (!p) { offTable++; continue; }
      n++; size[p.size] = (size[p.size] ?? 0) + 1; state[p.state] = (state[p.state] ?? 0) + 1;
    }
    ledger = recordSeason(ledger, factsOfCast(npcs.map((h) => ({ name: h.name, vocation: h.character.vocation, hometown: h.character.hometown }))));
  }
  const pct = (k: string, m: Record<string, number>) => (100 * (m[k] ?? 0)) / n;
  const sizeDev = Object.fromEntries(SIZES.map((k) => [k, pct(k, size) - CENSUS_SIZE[k]!]));
  const stateDev = Object.fromEntries(TOP_STATES.map((k) => [k, pct(k, state) - CENSUS_STATE[k]!]));
  return { n, offTable, sizeDev, stateDev };
}
const worst = (d: Record<string, number>) => Math.max(...Object.values(d).map(Math.abs));

describe("ORW-995 hometowns match census shares", () => {
  it("the settings that produced the skew have not drifted back", () => {
    expect(HOMETOWN_FLATTEN).toBe(1);
    expect(stateCap("CA", 15)).toBeGreaterThan(2); // a flat 2 held California to 11% of draws against 15.7% of residents
    expect(stateCap("WY", 15)).toBe(2);
  });

  it(`${CASTS} seeded casts: size-class shares within ${SIZE_TOL} points and the eight biggest states within ${STATE_TOL} points of the census`, () => {
    const r = measure(1000, CASTS);
    console.log(`ORW-995 ${CASTS} casts, ${r.n} draws, off-table ${r.offTable}; size dev ${JSON.stringify(r.sizeDev, (_, v) => (typeof v === "number" ? +v.toFixed(1) : v))}; state dev ${JSON.stringify(r.stateDev, (_, v) => (typeof v === "number" ? +v.toFixed(1) : v))}`);
    expect(r.offTable).toBe(0); // every dealt hometown is a place in the census table
    for (const k of SIZES) expect(Math.abs(r.sizeDev[k]!), `size ${k}`).toBeLessThanOrEqual(SIZE_TOL);
    for (const k of TOP_STATES) expect(Math.abs(r.stateDev[k]!), `state ${k}`).toBeLessThanOrEqual(STATE_TOL);
  }, 120000);

  it("the noise is well inside the tolerance: two other seed sets of 200 casts land within it too", () => {
    const runs = [measure(500000, 200), measure(9000000, 200)];
    for (const r of runs) { console.log(`ORW-995 noise run: worst size dev ${worst(r.sizeDev).toFixed(1)}, worst state dev ${worst(r.stateDev).toFixed(1)}`); expect(worst(r.sizeDev)).toBeLessThanOrEqual(SIZE_TOL); expect(worst(r.stateDev)).toBeLessThanOrEqual(STATE_TOL); }
  }, 120000);

  it("the tolerance bites: a 0.85 flatten (the old setting) draws towns far above their census share", () => {
    const table = buildTable(WORLD_PLACES, (p) => p.popK, 0.85);
    const rng = new SeededRandom(42);
    let town = 0; const N = 20000;
    for (let i = 0; i < N; i++) if (drawOne(rng, table).size === "town") town++;
    expect(100 * town / N - CENSUS_SIZE.town!).toBeGreaterThan(SIZE_TOL);
  });
});
