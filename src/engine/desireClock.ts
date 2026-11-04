import type { EntityId } from "../domain/ids";
import type { StructuralMilestone } from "./daySchedule";

/**
 * A8 - NPC approaches keyed to ELAPSED IN-GAME HOURS and each NPC's own DESIRE CLOCK (A0c design 3.5). An NPC's urge to seek the player rises as the event they care about
 * nears (a campaign before nominations, a plea before the vote) and is spent once they approach (an hours-based cooldown replaces the per-stretch rotation). PURE: no I/O, no rng,
 * no Vault - the inputs are public standing (HOH / nominee), the public schedule, the relationship DRIVE `rankApproaches` already computes, and the clock. Only the coarse desire
 * CATEGORY ever crosses to the narrator, never the number.
 */
export const DESIRE = {
  /** Hours before the event over which urgency climbs from 0 to its peak. */
  horizonHours: 6,
  /** In-game hours an NPC rests after approaching before the desire can build again. */
  cooldownHours: 3,
  /** A quiet baseline urge (just checking in) so a long idle stretch still produces the odd approach. */
  baseline: 0.15,
  /** An approach fires when urgency reaches this. */
  threshold: 0.5,
  weight: { campaign: 1.0, plea: 1.3, probe: 0.7, "check-in": 0 } as const,
} as const;

export type Desire = keyof typeof DESIRE.weight;

export interface DesireRole { isHoh: boolean; isNominee: boolean }

/** What this NPC wants from the player at the coming milestone, or `null` when nothing is pressing (e.g. the HOH, who is approached rather than approaching). */
export function desireFor(milestone: StructuralMilestone | undefined, role: DesireRole): Desire | null {
  if (role.isHoh) return null;
  switch (milestone) {
    case "nominations": return "campaign";                                  // everyone off the block lobbies for safety before the noms
    case "veto-competition":
    case "veto-ceremony": return role.isNominee ? "plea" : "probe";         // a nominee pleads for the save; others read the room
    case "eviction":
    case "final-eviction": return role.isNominee ? "plea" : "probe";        // a plea before the vote; others sound out the vote
    default: return "check-in";
  }
}

export interface UrgencyIn {
  desire: Desire;
  /** The relationship drive toward the player (`rankApproaches`): stronger ties approach more. */
  drive: number;
  /** Hours until the milestone is due; `null` when nothing is scheduled. */
  hoursUntil: number | null;
  /** Hours since this NPC last approached; `undefined` = never. */
  hoursSinceApproach: number | undefined;
}

/** 0..~2 - how badly this NPC wants to find the player right now. Monotone: rises as the event nears, is damped right after an approach, scales with the relationship drive. */
export function urgency(i: UrgencyIn): number {
  const proximity = i.hoursUntil === null ? 0 : 1 - Math.min(1, Math.max(0, i.hoursUntil) / DESIRE.horizonHours);
  const rested = i.hoursSinceApproach === undefined ? 1 : Math.min(1, Math.max(0, i.hoursSinceApproach) / DESIRE.cooldownHours);
  return (DESIRE.baseline + DESIRE.weight[i.desire] * proximity) * (0.5 + Math.max(0, i.drive)) * rested;
}

export interface Candidate { npc: EntityId; desire: Desire; drive: number; hoursSinceApproach: number | undefined }

/** The single most urgent NPC at/over the threshold, or `null`. Ties break on the lower id (stable, no rng). */
export function mostUrgent(cands: readonly Candidate[], hoursUntil: number | null): { npc: EntityId; desire: Desire; urgency: number } | null {
  let best: { npc: EntityId; desire: Desire; urgency: number } | null = null;
  for (const c of cands) {
    const u = urgency({ desire: c.desire, drive: c.drive, hoursUntil, hoursSinceApproach: c.hoursSinceApproach });
    if (u < DESIRE.threshold) continue;
    if (!best || u > best.urgency + 1e-12 || (Math.abs(u - best.urgency) <= 1e-12 && c.npc < best.npc)) best = { npc: c.npc, desire: c.desire, urgency: u };
  }
  return best;
}

/** A10 - how hard an unsatisfied want pulls the NPC's MOVEMENT toward its target: 1 at no urgency, up to 1 + k at/over the approach threshold. Pure; k is the single rollback knob. */
export const WANT_MOVEMENT = { k: 2 } as const;
export function wantScale(u: number, k: number = WANT_MOVEMENT.k): number {
  return 1 + k * Math.min(1, Math.max(0, u) / DESIRE.threshold);
}
