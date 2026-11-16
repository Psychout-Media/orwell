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

/** 1 = the world's own frequency. Slightly below 1 so the five largest cities do not take a third of all draws. */
export const HOMETOWN_FLATTEN = 0.5;
/** No more than this many of one state in a cast. */
export const MAX_PER_STATE = 2;
/** No more than this many of one place size class in a cast. */
export const MAX_PER_SIZE_CLASS = 6;

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
  const avoided = (p: WorldPlace): boolean => !!avoid && avoid.hometowns.has(p.city.toLowerCase());
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
      (p) => fresh(p) && plausible(p) && !avoided(p) && (state.get(p.state) ?? 0) < MAX_PER_STATE && regionOk(p) && (size.get(p.size) ?? 0) < MAX_PER_SIZE_CLASS,
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
