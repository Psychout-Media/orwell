/**
 * ORW-508 Layer 1: deal a cast's hometowns from the world place table at real-world frequency.
 *
 * Realism comes from the weights (a person is more likely to be from a big city than from one given small
 * town, in proportion to residents); the caps only stop a cast from clustering in one state or one size of
 * place. One `rng.next()` per attempt, on the caller's own side stream.
 */
import type { RandomnessSource } from "../../ports/RandomnessSource";
import type { AvoidSets } from "../../domain/recentSeasons";
import { WORLD_PLACES, type WorldPlace } from "./worldPlaces";
import { buildTable, drawConstrained } from "./worldSampler";
import { implausibleBecause, countRejection, type AcceptanceReport } from "./worldPlausibility";

/**
 * ORW-995: 1 = the world's own frequency (a draw is a resident of the table). It was 0.85, which moved about 10
 * points of draws from big cities to towns (towns 33.6% of draws against 24.0% of residents). Within a cast a
 * city is never drawn twice, so a big city cannot take a run of slots; the caps below stop clustering.
 */
export const HOMETOWN_FLATTEN = 1;
/** Floor of the per-state cap: a small state never takes more than this many of one cast. */
export const MAX_PER_STATE = 2;
/** Floor of the per-size-class cap. */
export const MAX_PER_SIZE_CLASS = 6;
/**
 * ORW-995: the caps follow population, not a flat number. A cast of `count` may hold up to ceil(count x share)
 * plus slack of one from a state and two from a size class, never less than the floors above, so a
 * state with 12% of residents can take 3 of 15 where a flat 2 held California to 10.8% of draws.
 */
export const CAP_SLACK_STATE = 1;
export const CAP_SLACK_SIZE = 2;

const totalPop = WORLD_PLACES.reduce((a, p) => a + p.popK, 0);
function shareBy(key: (p: WorldPlace) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of WORLD_PLACES) m.set(key(p), (m.get(key(p)) ?? 0) + p.popK / totalPop);
  return m;
}
const STATE_SHARE = shareBy((p) => p.state);
const SIZE_SHARE = shareBy((p) => p.size);
export function stateCap(state: string, count: number): number { return Math.max(MAX_PER_STATE, Math.ceil(count * (STATE_SHARE.get(state) ?? 0)) + CAP_SLACK_STATE); }
export function sizeCap(size: string, count: number): number { return Math.max(MAX_PER_SIZE_CLASS, Math.ceil(count * (SIZE_SHARE.get(size) ?? 0)) + CAP_SLACK_SIZE); }

const TABLE = buildTable(WORLD_PLACES, (p) => p.popK, HOMETOWN_FLATTEN);

export function dealWorldHometowns(
  rng: RandomnessSource, count: number, maxPerRegion: number, avoid?: AvoidSets,
  /** Per slot: the person's age and committed job, so the town is one this person can plausibly be from (acceptance). */
  people?: ReadonlyArray<{ age: number; vocation: string }>, report?: AcceptanceReport,
): string[] {
  const used = new Set<string>();
  const state = new Map<string, number>();
  const region = new Map<string, number>();
  const size = new Map<string, number>();
  // ORW-995: the memory never blocks a big city. There are only 37 of them and they hold a fifth of all residents,
  // so six seasons of ordinary draws had already used about half, and avoiding those took big cities from the
  // census 21.6% to 13.8% of draws. A repeat of Chicago is real life; a repeat of a town of 3,000 is the thing to avoid.
  const avoided = (p: WorldPlace): boolean => !!avoid && p.size !== "big-city" && avoid.hometowns.has(p.city.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const fresh = (p: WorldPlace): boolean => !used.has(p.city);
    const regionOk = (p: WorldPlace): boolean => (region.get(p.region) ?? 0) < maxPerRegion;
    const who = people?.[i];
    const plausible = (p: WorldPlace): boolean => {
      if (!who) return true;
      const why = implausibleBecause({ vocation: who.vocation, age: who.age, state: p.state, size: p.size });
      if (why) countRejection(report, why);
      return why === null;
    };
    const levels: Array<(p: WorldPlace) => boolean> = [
      (p) => fresh(p) && plausible(p) && !avoided(p) && (state.get(p.state) ?? 0) < stateCap(p.state, count) && regionOk(p) && (size.get(p.size) ?? 0) < sizeCap(p.size, count),
      (p) => fresh(p) && plausible(p) && !avoided(p) && regionOk(p),
      (p) => fresh(p) && plausible(p) && regionOk(p),
      (p) => fresh(p) && plausible(p),
      fresh,
    ];
    const p = drawConstrained(rng, TABLE, levels);
    if (who && implausibleBecause({ vocation: who.vocation, age: who.age, state: p.state, size: p.size }) && report) report.fallbacks++;
    used.add(p.city);
    state.set(p.state, (state.get(p.state) ?? 0) + 1);
    region.set(p.region, (region.get(p.region) ?? 0) + 1);
    size.set(p.size, (size.get(p.size) ?? 0) + 1);
    out.push(p.city);
  }
  return out;
}
