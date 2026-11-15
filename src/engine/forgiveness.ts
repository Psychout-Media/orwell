import type { MemoryEntry } from "./npcMemory";
import { FORGIVENESS } from "./forgivenessConstants";

/**
 * B27 / ORW-130 - the pure forgiveness layer. Whether a houseguest holds a grudge against ONE other houseguest is a readable function of who they are and what happened between them (see the table in
 * `forgivenessConstants.ts`): temperament + how bad + repeat betrayals + favors + closeness. No randomness, no shared stream, no I/O, no Vault, nothing numeric ever shown to the player. `applyForgiveness`
 * returns the ENTRIES the memory read should see: a held grudge's real betrayals read no older than `floorAgeWeeks`; otherwise favors age `favorFade` times faster. It never mutates the ledger or changes a severity.
 */
export type ForgivenessTrait = "grudge-keeper" | "typical";

export interface ForgivenessInput {
  /** The holder's strategy style (unknown/undefined => the default term). */
  style?: string;
  /** The holder's soul volatility, 0..1. */
  volatility: number;
  /** The holder's bond with the other houseguest, 0..1 (the closeness proxy). */
  closeness: number;
}

const unit = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);

/** The score the holder weighs; exported so the readable terms can be tested. */
export function holdScore(entries: readonly MemoryEntry[] | undefined, who: ForgivenessInput): number {
  const F = FORGIVENESS;
  const betrayals = (entries ?? []).filter((e) => F.betrayalKinds.includes(e.kind));
  if (betrayals.length === 0) return 0;
  const worst = betrayals.reduce((m, e) => Math.max(m, e.severity), 0);
  const favors = (entries ?? []).filter((e) => F.favorKinds.includes(e.kind)).reduce((s, e) => s + e.severity, 0);
  const again = Math.min(F.repeatMax, betrayals.length - 1);
  const sign = F.closeSign[who.style ?? ""] ?? 0.5;
  return (F.style[who.style ?? ""] ?? F.styleDefault)
    + F.volatility * unit(who.volatility)
    + F.severity * unit(worst)
    + F.repeat * again
    - F.favor * Math.min(favors, F.favorMax)
    + F.closeness * sign * unit(who.closeness);
}

export function forgivenessTraitFor(entries: readonly MemoryEntry[] | undefined, who: ForgivenessInput): ForgivenessTrait {
  return holdScore(entries, who) >= FORGIVENESS.holdAt ? "grudge-keeper" : "typical";
}

export function applyForgiveness(entries: readonly MemoryEntry[] | undefined, trait: ForgivenessTrait, week: number): readonly MemoryEntry[] | undefined {
  if (!entries || entries.length === 0) return entries;
  return entries.map((e) => {
    if (trait === "grudge-keeper" && FORGIVENESS.betrayalKinds.includes(e.kind)) {
      return { ...e, week: Math.max(e.week, week - FORGIVENESS.floorAgeWeeks) };
    }
    if (trait === "typical" && FORGIVENESS.favorKinds.includes(e.kind)) {
      const age = Math.max(0, week - e.week);
      return { ...e, week: week - age * FORGIVENESS.favorFade };
    }
    return e;
  });
}
