import type { EntityId } from "../domain/ids";
import { CREDIBILITY } from "./credibilityConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * B48 - CREDIBILITY MEMORY (pure: no I/O, no rng, no Vault, no clock). `credibility(evidence, repeatsToListener, nowWeek)` is how far an OBSERVER believes a SPEAKER's word, 0..1 (1 = fully).
 * It is derived ONLY from lies the observer CAUGHT (a `lied-to-me` claim or a broken casual assurance the observer holds) - what the observer could actually know - plus how many lies the speaker has
 * already told this same ear. Monotone: more caught lies / more repeats never RAISE it; a caught lie's weight decays with age; always bounded to [CREDIBILITY.floor, 1].
 * The caller (the adapter) supplies the evidence from the observer's OWN belief claims; this module never reads a store.
 */
export interface CaughtLie {
  /** The speaker who lied. */
  speaker: EntityId;
  /** The week the lie was caught. */
  week: number;
  /** 0..1, how serious it was (default 1). */
  severity?: number;
}


export function credibility(evidence: readonly CaughtLie[], repeatsToListener: number, nowWeek: number): number {
  let c = 1;
  const n = Math.min(evidence.length, CREDIBILITY.evidenceSafetyValve);
  for (let i = 0; i < n; i++) {
    const e = evidence[i]!;
    const age = Math.max(0, nowWeek - e.week);
    const recency = Math.pow(0.5, age / CREDIBILITY.halfLifeWeeks);
    c *= 1 - clamp01(CREDIBILITY.perCaughtLie * clamp01(e.severity ?? 1) * recency);
  }
  c *= Math.pow(CREDIBILITY.perRepeatToListener, Math.max(0, Math.floor(repeatsToListener)));
  return Math.max(CREDIBILITY.floor, Math.min(1, c));
}
