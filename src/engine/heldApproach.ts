/**
 * ORW-452 point 2 (Kevin with Ryne, 2026-11-15: "This should be dynamic based on character sheets involved"): a houseguest whose approach the same-purpose cap HELD BACK (the player was not interrupted) decides what to do
 * next from their OWN sheet, not one rule for everyone: come straight back (keep the want), wait out the normal cooldown, or give up for a longer while. Pure and deterministic (a seeded jitter only separates near ties);
 * no rng, no Vault.
 */
import { clamp01 } from "../domain/num";

export type HeldReaction = "comes-straight-back" | "waits" | "gives-up";
export const HELD_REACTIONS: readonly HeldReaction[] = ["comes-straight-back", "waits", "gives-up"];

export interface HeldSheet {
  /** How persistent, how proud and how patient their archetype makes them (0..1). */
  persistence: number;
  pride: number;
  patience: number;
  /** How much they want the player / how they feel about them (0..1). */
  affinityToPlayer: number;
}

const ARCHETYPE: Readonly<Record<string, { persistence: number; pride: number; patience: number }>> = {
  hothead: { persistence: 0.9, pride: 0.6, patience: 0.1 }, underdog: { persistence: 0.8, pride: 0.3, patience: 0.5 }, loyalist: { persistence: 0.7, pride: 0.2, patience: 0.6 },
  "comp-beast": { persistence: 0.6, pride: 0.6, patience: 0.3 }, flirt: { persistence: 0.6, pride: 0.5, patience: 0.3 }, "social-butterfly": { persistence: 0.55, pride: 0.3, patience: 0.4 },
  wildcard: { persistence: 0.5, pride: 0.4, patience: 0.3 }, villain: { persistence: 0.5, pride: 0.8, patience: 0.5 }, mastermind: { persistence: 0.4, pride: 0.7, patience: 0.7 },
  peacemaker: { persistence: 0.4, pride: 0.1, patience: 0.8 }, analyst: { persistence: 0.35, pride: 0.4, patience: 0.8 }, floater: { persistence: 0.3, pride: 0.2, patience: 0.6 },
};

/** The sheet's persistence, pride and patience from the archetype (an unknown archetype is middling). */
export function heldSheetOf(archetype: string | undefined, affinityToPlayer: number): HeldSheet {
  const a = ARCHETYPE[archetype ?? ""] ?? { persistence: 0.5, pride: 0.4, patience: 0.5 };
  return { ...a, affinityToPlayer };
}


/** What a held-back houseguest does next: the highest score for THIS sheet. `jitter` (0..0.05, seeded) only separates near ties. */
export function heldApproachReaction(s: HeldSheet, jitter = 0): HeldReaction {
  const pe = clamp01(s.persistence), pr = clamp01(s.pride), pa = clamp01(s.patience), ap = clamp01(s.affinityToPlayer);
  const scores: Record<HeldReaction, number> = {
    "comes-straight-back": 0.8 * pe + 0.5 * ap - 0.3 * pr - 0.2 * pa,
    waits: 0.8 * pa + 0.2 * (1 - pr) + 0.15 + jitter,
    "gives-up": 0.7 * pr + 0.5 * (1 - ap) - 0.4 * pe,
  };
  let best: HeldReaction = "waits";
  for (const k of HELD_REACTIONS) if (scores[k] > scores[best]) best = k;
  return best;
}
