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

/**
 * Feature 0180 part 2 - BANDWAGONS AND DISSENT. PURE: no rng, no I/O. What a voter counts is what THEY hold, never anyone's ballot.
 *
 * The herd: before a vote, a voter reads where the house is going from who they have heard is going after each nominee (`heard-rumor`, nature `going-after`,
 * this week, one voice per houseguest). With enough voices, a bounded term pulls them toward the side the house is on; it only tips a close call (a voter with
 * a strong reason of their own keeps it). The culture's alliance-size dial ("a majority bloc") makes the house herd harder.
 *
 * Dissent noticed: after the vote, a houseguest who voted with the majority and has heard (vote talk, this week) that someone voted the other way cools on
 * them, more the more lopsided the vote was (a lone dissent in a blowout stands out most). Bounded, once per pair per week.
 */
export const HERD = {
  /** The fewest distinct voices (houseguests heard going after a nominee) before the herd pulls at all. */
  minVoices: 2,
  /** The pull toward the house's side at a unanimous read, before the culture (signed: + toward evicting that nominee). */
  weight: 0.18,
  /** The cooling on a known dissenter (affinity, trust) at a unanimous-but-one count, scaled by how lopsided the vote was. */
  dissentAffinity: -0.05,
  dissentTrust: -0.03,
  /** Below this majority share (evict votes / voters) a split vote is just a split: no one is singled out. */
  dissentMinMajority: 0.6,
} as const;

/** The voices `voter` holds for each nominee: distinct houseguests they heard are going after that nominee this week (never the voter themself). */
export function herdVoices(held: readonly BeliefClaim[], voter: EntityId, nominees: readonly [EntityId, EntityId], week: number): [number, number] {
  const voices: [Set<EntityId>, Set<EntityId>] = [new Set(), new Set()];
  for (const b of held) {
    if (!b.value || b.refuted || b.week !== week || b.kind !== "heard-rumor" || b.nature !== "going-after" || b.subject === voter) continue;
    const i = nominees.indexOf(b.object as EntityId);
    if (i >= 0 && !nominees.includes(b.subject)) voices[i]!.add(b.subject);
  }
  return [voices[0].size, voices[1].size];
}

/** The herd's pull toward evicting nominee index `i` (signed), from the voices and the culture's alliance-size dial (`dialMult`, 1 = neutral). 0 below `minVoices`. */
export function herdPull(voices: readonly [number, number], i: 0 | 1, sizeDial: number): number {
  const total = voices[0] + voices[1];
  if (total < HERD.minVoices) return 0;
  return HERD.weight * Math.max(0, sizeDial) * (2 * (voices[i] / total) - 1);
}

/** Who `holder` heard voted against the majority at this week's eviction (vote talk: kept the evictee, or voted against the survivor). Never the holder themself. */
export function heardDissenters(held: readonly BeliefClaim[], holder: EntityId, evictee: EntityId, survivor: EntityId, week: number): EntityId[] {
  const out = new Set<EntityId>();
  for (const b of held) {
    if (!b.value || b.refuted || b.week !== week || b.kind !== "heard-rumor" || b.subject === holder) continue;
    if ((b.nature === "voted-to-keep" && b.object === evictee) || (b.nature === "voted-against" && b.object === survivor)) out.add(b.subject);
  }
  return [...out].sort();
}

/** The cooling a majority voter applies to a dissenter they heard of: none below `dissentMinMajority`, scaled up to full at a unanimous-but-one count. */
export function dissentMove(evictVotes: number, voters: number): { affinity: number; trust: number } {
  if (voters <= 1) return { affinity: 0, trust: 0 };
  const share = evictVotes / voters;
  if (share < HERD.dissentMinMajority) return { affinity: 0, trust: 0 };
  const k = Math.min(1, (share - HERD.dissentMinMajority) / Math.max(1e-9, (voters - 1) / voters - HERD.dissentMinMajority));
  return { affinity: HERD.dissentAffinity * k, trust: HERD.dissentTrust * k };
}
