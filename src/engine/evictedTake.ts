import type { EntityId } from "../domain/ids";
import type { DealKind } from "../domain/deal";

/**
 * 0195 (ORW-628, Ryne OK'd 2026-11-17) - WHAT THE EVICTED TAKE WITH THEM. When a houseguest leaves, what they held leaves with them, and the house works out what
 * changed:
 *   - their open deals lapse (neutral: not kept, not broken, no fold);
 *   - a favor owed TO them passes to their closest ally still in the house (the engine's call, for an NPC evictee) or lapses; a favor they OWED lapses;
 *   - their open assurances, both ways, lapse;
 *   - what they knew goes to the jury house with them (it no longer spreads in the house).
 * The ones left react to what they lost or were freed from: RELIEF for a debtor let off, or a partner who was planning to break the deal anyway; WORRY for a partner
 * who lost a shield. PURE: no rng, no I/O, no Vault handle. Engine-only: nothing here is shown as a number.
 */
export const EVICTED_TAKE = {
  /** How much a lapsed deal shielded its partner, by kind (an engine key: how much worry its loss carries). */
  shield: { "final-two": 1, safety: 0.8, "veto-save": 0.7, vote: 0.6, "protect-third": 0.4, conditional: 0.3, information: 0.2, "target-other": 0, "comp-throw": 0 } as Readonly<Record<DealKind, number>>,
  /** The mood scale of the worry at a full shield, and of the relief per favor freed (the existing emotional-arc events, scaled). */
  worryScale: 0.5,
  reliefPerFavor: 0.25,
  reliefPlanScale: 0.4,
  /** At most this much relief from favors at once. */
  reliefCap: 0.6,
} as const;

/** The evictee's heir for a favor they held: their closest living ally at or above `passBond`, never the debtor. Ties by id. Undefined = it lapses. */
export function heirOf(evictee: EntityId, debtor: EntityId, living: readonly EntityId[], bond: (from: EntityId, to: EntityId) => number, passBond: number): EntityId | undefined {
  let best: EntityId | undefined;
  let bestBond = -Infinity;
  for (const id of [...living].sort()) {
    if (id === evictee || id === debtor) continue;
    const b = bond(evictee, id);
    if (b >= passBond && b > bestBond) { best = id; bestBond = b; }
  }
  return best;
}

/** How a deal's partner takes its lapse: relief when their own plan was to break it, else worry by how much it shielded them. */
export function partnerReaction(kind: DealKind, partnerPlannedToBreak: boolean): { kind: "relief" | "worry"; scale: number } | undefined {
  if (partnerPlannedToBreak) return { kind: "relief", scale: EVICTED_TAKE.reliefPlanScale };
  const shield = EVICTED_TAKE.shield[kind] ?? 0;
  return shield > 0 ? { kind: "worry", scale: EVICTED_TAKE.worryScale * shield } : undefined;
}

/** The relief of a debtor let off `freed` favors. */
export const debtorRelief = (freed: number): number => Math.min(EVICTED_TAKE.reliefCap, EVICTED_TAKE.reliefPerFavor * freed);
