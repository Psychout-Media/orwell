import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { BeliefClaim } from "./beliefStore";
import type { SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0156 / ORW-330 (theme 2, slice 7a) - HOUSE MEETINGS, the engine half. A rumor goes PUBLIC: someone calls the house together and accuses a houseguest of a claim from the claims core's fixed
 * set; the accused answers (deny / admit / redirect, decided here from the TRUTH, the accused's candor and cunning and how the room trusts each side); each NPC present then decides who to believe
 * from how much they trust each side. Pure rules: no I/O, no rng handle, no Vault. The caller supplies the truth, the trust reads and every seeded draw (its own side stream `${seed}:house-meeting`),
 * so this module is deterministic and calibration-neutral until the adapter calls it. The narrator only ever gets the speakers' words (`HeardMeeting`): never the truth, the intent, an id or a listener's outcome.
 */

export type MeetingAnswer = "deny" | "admit" | "redirect";
export type ListenerOutcome = "holds-harder" | "doubts" | "unmoved";
export type MeetingCaller = "player" | "npc";

/** Who may call a house meeting is decided HERE and nowhere else (the owner has not answered; "player+npc" is the default, "npc" or "player" the other answers). */
export const MEETING_RULES: { callers: "player+npc" | "npc" | "player" } = { callers: "player+npc" };
export function canCallMeeting(who: MeetingCaller): boolean {
  return MEETING_RULES.callers === "player+npc" || MEETING_RULES.callers === who;
}

/** The claim kinds a public accusation can carry: the ones that are about the ACCUSED and read the same to every listener (the two listener-relative kinds are not). */
export const MEETING_CLAIM_KINDS: readonly SpokenClaimKind[] = ["going-after", "final-two-with", "talking-about", "lying-about"];

export const MEETING = {
  /** A belief this confident (about a grievance) is strong enough to call the house together over. ONE small function (`grievanceStrength`) so slice 2's `believedGrievance().strength` replaces it. */
  grievanceMin: 0.7,
  /** Chance per in-game day that an NPC with a strong grievance calls (the once-a-week cap applies on top). */
  callChancePerDay: 0.15,
  /** Answer weights. */
  admitBase: 0.1, admitCandor: 0.6,
  redirectBase: 0.05, redirectCunning: 0.5, redirectRoomSwing: 0.3,
  /** |trust in accuser - trust in accused| within this is a shrug (the listener stays where they were). */
  shrugMargin: 0.05,
  /** A redirect hands the accused's word this much extra standing with a listener who already half-believes them. */
  redirectSway: 0.05,
  /** Confidence an admission lifts a listener's belief to; a held-harder denial adds `holdBump`. */
  admitConfidence: 0.95, holdBump: 0.15,
} as const;

/** Archetype cunning (0..1): how readily the accused turns it around on the accuser. */
const CUNNING_BY_ARCHETYPE: Readonly<Record<string, number>> = {
  mastermind: 0.9, villain: 0.8, analyst: 0.6, wildcard: 0.55, "social-butterfly": 0.5, flirt: 0.5, floater: 0.4,
  "comp-beast": 0.35, underdog: 0.3, peacemaker: 0.25, loyalist: 0.2, hothead: 0.15,
};
export function cunningOf(archetype: string | undefined): number { return (archetype !== undefined ? CUNNING_BY_ARCHETYPE[archetype] : undefined) ?? 0.4; }

export interface AnswerInput {
  /** The engine's own check of the claim (never handed outward). */
  isTrue: boolean;
  candor: number;
  cunning: number;
  /** Mean over the room of (trust in the accuser - trust in the accused), -1..1: positive = the room sides with the accuser. */
  roomLean: number;
  /** A seeded draw in [0,1) from the caller's own side stream. */
  roll: number;
}

/**
 * The accused's answer. A true accusation can be admitted, denied or redirected; a false one only denied or redirected. A candid accused admits more (when it is true); a cunning one redirects more, and
 * more when the room already leans to the accuser (they need a counter). Deterministic: the same inputs always give the same answer.
 */
export function decideAnswer(i: AnswerInput): MeetingAnswer {
  const admit = i.isTrue ? MEETING.admitBase + MEETING.admitCandor * clamp01(i.candor) : 0;
  const redirect = MEETING.redirectBase + MEETING.redirectCunning * clamp01(i.cunning) + MEETING.redirectRoomSwing * Math.max(0, Math.min(1, i.roomLean));
  const deny = Math.max(0.05, 1 - admit - redirect) * (i.isTrue ? 0.5 + 0.5 * (1 - clamp01(i.candor)) : 1);
  const total = admit + redirect + deny;
  const r = clamp01(i.roll) * total;
  if (r < admit) return "admit";
  if (r < admit + redirect) return "redirect";
  return "deny";
}

/** How one NPC listener comes out of the answer. An admission confirms; otherwise whoever they trust more wins them (a shrug inside the margin). A redirect nudges toward the accused. */
export function listenerOutcome(trustInAccuser: number, trustInAccused: number, answer: MeetingAnswer): ListenerOutcome {
  if (answer === "admit") return "holds-harder";
  const diff = trustInAccuser - trustInAccused - (answer === "redirect" ? MEETING.redirectSway : 0);
  if (diff > MEETING.shrugMargin) return "holds-harder";
  if (diff < -MEETING.shrugMargin) return "doubts";
  return "unmoved";
}

/** THE grievance-strength read (swappable in one place for slice 2's `believedGrievance().strength`). Only beliefs that are a grievance against someone else count. */
export function grievanceStrength(b: BeliefClaim, holder: EntityId, player: EntityId): number {
  if (b.refuted || !b.value || b.subject === holder || b.subject === player) return 0;
  if (b.kind !== "targets-me" && b.kind !== "voted-against-me" && b.kind !== "lied-to-me") return 0;
  return clamp01(b.confidence);
}

export interface Grievance { holder: EntityId; subject: EntityId; kind: SpokenClaimKind; object: EntityId; strength: number }

/** The strongest strong grievance a houseguest holds, as the accusation it would make ("S is going after me" / "S is lying to me"). Ties break on the earliest belief. */
export function strongestGrievance(beliefs: readonly BeliefClaim[], holder: EntityId, player: EntityId): Grievance | undefined {
  let best: Grievance | undefined;
  for (const b of beliefs) {
    const strength = grievanceStrength(b, holder, player);
    if (strength < MEETING.grievanceMin || (best && strength <= best.strength)) continue;
    best = { holder, subject: b.subject, kind: b.kind === "lied-to-me" ? "lying-about" : "going-after", object: holder, strength };
  }
  return best;
}

/** Does this NPC call a meeting today? At most once per week per house (`calledThisWeek`), only with a strong grievance, on the caller's seeded `roll`. */
export function npcWouldCall(g: Grievance | undefined, calledThisWeek: boolean, roll: number): boolean {
  return canCallMeeting("npc") && g !== undefined && !calledThisWeek && roll < MEETING.callChancePerDay;
}

/** The engine-only record (append-only, kept whole, NEVER projected whole). */
export interface HouseMeeting {
  id: string;
  week: number;
  day: number;
  caller: EntityId;
  accused: EntityId;
  claim: { kind: SpokenClaimKind; subject: EntityId; object?: EntityId };
  accuser: EntityId;
  /** The accusation's claim id in the claims log (`claim:<n>`, the claim told to the first NPC attendee): engine-only, so slice 5 can join a refuted belief back to its meeting. */
  claimId: string;
  /** Every accusation claim id, one per NPC listener (belief ids end in `|<claimId>`). */
  claimIds: string[];
  answer: MeetingAnswer;
  redirect?: { to: EntityId };
  attendees: EntityId[];
  playerPresent: boolean;
}

/** What the player heard, as names (the narrator seam): the speakers' words only. Built field by field, so the truth, intent, ids and outcomes can never ride along. */
export interface HeardMeeting {
  caller: string;
  accused: string;
  claim: { kind: SpokenClaimKind; subject: string; object?: string };
  answer: MeetingAnswer;
  redirectTo?: string;
}
export function heardMeeting(m: HouseMeeting, nameOf: (id: EntityId) => string): HeardMeeting {
  return {
    caller: nameOf(m.caller), accused: nameOf(m.accused),
    claim: { kind: m.claim.kind, subject: nameOf(m.claim.subject), ...(m.claim.object !== undefined ? { object: nameOf(m.claim.object) } : {}) },
    answer: m.answer, ...(m.redirect ? { redirectTo: nameOf(m.redirect.to) } : {}),
  };
}
