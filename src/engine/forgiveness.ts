import type { MemoryEntry } from "./npcMemory";
import { FORGIVENESS } from "./forgivenessConstants";

/**
 * B27 - the pure forgiveness layer. `forgivenessTraitOf(seed)` is a deterministic function of an integer seed (the caller derives one per houseguest from the game seed and the houseguest id; it
 * touches no shared random stream). `applyForgiveness` returns the ENTRIES the memory read should see: a grudge-keeper's real betrayals are held no older than `floorAgeWeeks`; everyone else's favors
 * age `favorFade` times faster. It never mutates the ledger and never changes severity. Absent the layer the ledger is read as it always was.
 */
export type ForgivenessTrait = "grudge-keeper" | "typical";

const unit = (seed: number): number => {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x7f4a7c15) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function forgivenessTraitOf(seed: number): ForgivenessTrait {
  return unit(seed) < FORGIVENESS.grudgeKeeperShare ? "grudge-keeper" : "typical";
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
