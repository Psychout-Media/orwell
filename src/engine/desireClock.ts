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
  /** ORW-340: a houseguest whose OWN GOAL brought them to the player (an hourly plan that names the player) approaches at this urgency (over the threshold, under a milestone's peak), once rested. */
  goalUrgency: 1.0,
  /** ORW-340: how long a goal-driven plan stays a live reason to approach, in in-game hours (it lapses if no conversation opens the door). */
  goalFreshHours: 3,
  /** ORW-340: below this trust in the player an NPC avoids them: their goal does not bring them over. */
  goalMinTrust: 0.25,
  /** ORW-423 (played games only): at most this many CONSECUTIVE approaches of the same purpose (desire) reach the player in one stretch; the next one is HELD: the player is not interrupted. What that houseguest does NEXT comes from their own sheet (ORW-452 point 2, `heldOutcome`): comes back soon, waits the normal cooldown, goes elsewhere, or gives up. Never queued. */
  streakCap: 2,
  /** ORW-423: in-game hours without any approach that end a stretch (the cap releases). */
  streakQuietHours: 2,
} as const;

/**
 * ORW-452 point 2 (ruling: "dynamic based on character sheets involved"): what a houseguest held back by the cap does next, from THEIR OWN sheet. PURE: no rng, no Vault; only a public strategy style
 * and the houseguest's own edge toward the player are read, and neither the score nor the outcome ever crosses to the player (only the cooldown stamp changes, as the old 3 h one did).
 * score = persistenceWeight * persistence(style) + (1 - persistenceWeight) * want(affinity, trust toward the player).
 */
export const HELD = {
  /** How stubborn each strategy style is about a want (0..1): the pushy and the loyal return, the quiet and the strategic bide. */
  persistence: { aggressive: 0.9, loyal: 0.8, emotional: 0.6, social: 0.5, strategic: 0.4, "under-the-radar": 0.2 } as Record<string, number>,
  /** Persistence for a style not in the table (a model-authored one): the middle. */
  persistenceDefault: 0.5,
  /** Share of the score that is persistence (the rest is how much they want the player). */
  persistenceWeight: 0.5,
  /** score at/over this: COMES BACK soon (keeps the want). */
  comeBackAt: 0.65,
  /** score under this: GIVES UP. */
  giveUpBelow: 0.25,
  /** Driven (persistence at/over `elsewherePersistence`) but wanting the player under `elsewhereWantBelow`: GOES TO SOMEONE ELSE. */
  elsewherePersistence: 0.5,
  elsewhereWantBelow: 0.2,
  /** In-game hours until the want can build again, per outcome. `wait` is the old fixed 3 h (DESIRE.cooldownHours). */
  cooldownHours: { "come-back": 2, wait: 3, elsewhere: 5, "give-up": 6 } as const,
} as const;

export type HeldOutcome = keyof typeof HELD.cooldownHours;
export interface HeldSheet { strategyStyle: string; /** their edge toward the player, each -1..1 */ affinity: number; trust: number }

/** ORW-452 point 2: the held houseguest's next step and its cooldown, from their own sheet. Same sheet => same outcome. */
export function heldOutcome(sheet: HeldSheet): { outcome: HeldOutcome; cooldownHours: number } {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const persistence = HELD.persistence[sheet.strategyStyle] ?? HELD.persistenceDefault;
  const want = clamp01((sheet.affinity + sheet.trust) / 2);
  const score = HELD.persistenceWeight * persistence + (1 - HELD.persistenceWeight) * want;
  const outcome: HeldOutcome = score < HELD.giveUpBelow ? "give-up"
    : persistence >= HELD.elsewherePersistence && want < HELD.elsewhereWantBelow ? "elsewhere"
    : score >= HELD.comeBackAt ? "come-back" : "wait";
  return { outcome, cooldownHours: HELD.cooldownHours[outcome] };
}

/** ORW-423: the running run of same-purpose approaches (Vault-free: a coarse desire, a count, an hour). */
export interface ApproachStreak { desire: string; count: number; lastHour: number }

/** ORW-423: does the cap hold for an approach of `desire` at `hour`? Pure, no rng. A different purpose or a quiet stretch releases it. */
export function streakHolds(streak: ApproachStreak | undefined, desire: string, hour: number): boolean {
  if (!streak || streak.desire !== desire) return false;
  if (hour - streak.lastHour >= DESIRE.streakQuietHours) return false;
  return streak.count >= DESIRE.streakCap;
}

/** ORW-423: the streak after an approach of `desire` at `hour`. */
export function nextStreak(streak: ApproachStreak | undefined, desire: string, hour: number): ApproachStreak {
  const same = streak && streak.desire === desire && hour - streak.lastHour < DESIRE.streakQuietHours;
  return { desire, count: same ? streak!.count + 1 : 1, lastHour: hour };
}

export type Desire = keyof typeof DESIRE.weight;

export interface DesireRole { isHoh: boolean; isNominee: boolean }

/** What this NPC wants from the player at the coming milestone, or `null` when nothing is pressing (e.g. the HOH, who is approached rather than approaching). */
export function desireFor(milestone: StructuralMilestone | undefined, role: DesireRole): Desire | null {
  if (role.isHoh) return null;
  switch (milestone) {
    case "nominations": return "campaign";                                  // everyone off the block lobbies for safety before the noms
    case "veto-draw": // ORW-281: the draw is its own milestone; the pressure is the veto's
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
// `ORWELL_WANT_MOVEMENT_K` overrides k for calibration MEASUREMENT only (the deploy never sets it); default 1 - MEASURED 2026-11-04 (juryReach 20-seed): k=0.5 and 1 pass; k=1.5 and 2 fail seed 18 (a passive player crowned with 1 public comp win); gradient + movementStreamIsolation pass at k=1.
const _k = Number(process.env.ORWELL_WANT_MOVEMENT_K);
export const WANT_MOVEMENT = { k: Number.isFinite(_k) && _k >= 0 && process.env.ORWELL_WANT_MOVEMENT_K !== undefined ? _k : 1 } as { k: number };
export function wantScale(u: number, k: number = WANT_MOVEMENT.k): number {
  return 1 + k * Math.min(1, Math.max(0, u) / DESIRE.threshold);
}

/**
 * ORW-340: the desire an hourly house-life action names when it is aimed at the player. A closed mapping from the action's kind to the nearest EXISTING approach desire, so the narrator
 * already knows how to voice it: begging and bargaining are a plea; pitching, recruiting and lobbying are a campaign; counting or flipping a vote is a probe; anything else (comfort, checking in)
 * is a check-in. Only the category crosses to the narrator, never the goal.
 */
export function desireForAction(kind: string): Desire {
  switch (kind) {
    case "beg": case "bargain": case "call-in-favor": case "make-a-promise": return "plea";
    case "pitch": case "recruit": case "lobby-for": case "split-roles": return "campaign";
    case "count-votes": case "flip-a-vote": case "campaign-against": case "confront": return "probe";
    default: return "check-in";
  }
}

/** ORW-340: the goal-driven approacher: among rested candidates the one with the strongest tie to the player (ties break on the lower id; no rng), or `null`. */
export function goalDriven(cands: readonly Candidate[]): { npc: EntityId; desire: Desire } | null {
  let best: Candidate | null = null;
  for (const c of cands) {
    if (c.hoursSinceApproach !== undefined && c.hoursSinceApproach < DESIRE.cooldownHours) continue; // the cooldown still holds
    if (!best || c.drive > best.drive + 1e-12 || (Math.abs(c.drive - best.drive) <= 1e-12 && c.npc < best.npc)) best = c;
  }
  return best ? { npc: best.npc, desire: best.desire } : null;
}
