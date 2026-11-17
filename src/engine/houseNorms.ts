import type { EntityId } from "../domain/ids";
import type { BeliefClaim } from "./beliefStore";

/**
 * Feature 0180 - Theme 3 slice 12 part 1 (ORW-552): HOUSE NORMS. The house enforces its own rules: a houseguest known to break their word is shunned by the
 * house, not only by the people they wronged. PURE: no rng, no I/O.
 *
 * What an observer counts is what THEY hold (Theme 2 pathways), never the hidden truth:
 *  - they were lied to by X themself (`lied-to-me` about X);
 *  - they heard X lied to someone else (`heard-rumor`, nature "lying", subject X), one per person X lied to.
 * At `NORMS.threshold` distinct incidents the observer starts to shun X; each further incident deepens it. The shunning is a bounded move in the
 * observer's own read of X (affinity and trust down) - the same hidden edge every decision already reads, never shown to the player.
 * The house culture moves it: a house that prizes honesty (low lying dial, high loyalty dial) shuns harder; a house of liars barely notices.
 */
export const NORMS = {
  /** Distinct known incidents before the house starts to shun a promise-breaker. */
  threshold: 2,
  /** The move per incident at and beyond the threshold (affinity, trust), before the culture. */
  affinityPerIncident: -0.06,
  trustPerIncident: -0.05,
  /** The most incidents that count (the move stays bounded however notorious they become). */
  maxIncidents: 6,
  /** The culture's reach: multiplier = 1 + cultureSpan * ((loyalty - 1) - (lying - 1)), floored at 0. */
  cultureSpan: 0.6,
} as const;

/** The incidents of broken word `observer` knows about `subject` (distinct people lied to; the observer's own counts once). */
export function knownBreaches(held: readonly BeliefClaim[], observer: EntityId, subject: EntityId): number {
  if (subject === observer) return 0;
  const victims = new Set<string>();
  for (const b of held) {
    if (!b.value || b.refuted || b.subject !== subject) continue;
    if (b.kind === "lied-to-me") victims.add(observer);
    else if (b.kind === "heard-rumor" && b.nature === "lying" && b.object !== undefined && b.object !== subject) victims.add(b.object);
  }
  return Math.min(NORMS.maxIncidents, victims.size);
}

/** The culture multiplier on shunning (`dialMult` values; 1 = neutral). */
export function normStrength(loyaltyDial: number, lyingDial: number): number {
  return Math.max(0, 1 + NORMS.cultureSpan * ((loyaltyDial - 1) - (lyingDial - 1)));
}

/** How many incidents are newly over the threshold since `applied` (what was already folded), and the edge move they make. */
export function shunMove(known: number, applied: number, strength: number): { incidents: number; affinity: number; trust: number } {
  const over = Math.max(0, known - (NORMS.threshold - 1)); // the threshold incident counts as the first shunning one
  const fresh = Math.max(0, over - applied);
  return { incidents: fresh, affinity: fresh * NORMS.affinityPerIncident * strength, trust: fresh * NORMS.trustPerIncident * strength };
}
