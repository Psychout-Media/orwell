import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * Feature 0184 part 2b (Theme 3 slice 8, ORW-564) - A PAIR FAKES DISTANCE IN PUBLIC. Two houseguests who are truly close may decide, week by week, to hide it: they keep
 * their time together low-key, so the people in the room mostly do not register it; under own-view (ORW-574, played games) the house reads a pair only from the scenes it registered, so a hidden pair reads as no closer than it has seen. A houseguest who CATCHES
 * them (a keyed per-onlooker roll) reads them as before. Engine-decided, seeded, engine-only: nothing here is ever a number or a label to anyone.
 */
export const HIDE = {
  /** Both must feel at least this close (each one's bond strength toward the other) for the pair to have anything to hide. */
  bondAtLeast: 0.6,
  /** The weekly chance a close pair hides it: a base, more as either of them is cunning (0..1), more in a paranoid house (the culture's paranoia dial, 1 = neutral). */
  base: 0.15,
  cunningWeight: 0.35,
  paranoiaWeight: 0.3,
  /** Each onlooker in the room catches a hidden pair's time together with this chance (keyed per scene and onlooker). */
  catchChance: 0.2,
} as const;

/** The kinds of time together a hiding pair keeps low-key (a fight is never hidden: that is not closeness). */
export const HIDDEN_TYPES: ReadonlySet<string> = new Set(["bonding", "showmance", "strategy", "alliance"]);

/** The weekly chance a close pair hides it. */
export function hideChance(cunningMax: number, paranoiaMult: number): number {
  return clamp01(HIDE.base + HIDE.cunningWeight * clamp01(cunningMax) + HIDE.paranoiaWeight * (paranoiaMult - 1));
}
