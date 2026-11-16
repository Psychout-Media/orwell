import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import { recordClaim, type BeliefStore, type ClaimKind } from "./beliefStore";
import { heardConfidence, tellerReliability } from "./heardAboutMe";
import { convictionFor } from "./beliefConviction";

/**
 * Feature 0149 / ORW-330 (theme 2, slice 1) - THE CLAIMS CORE. What one houseguest tells another about the house is an ENGINE decision,
 * recorded here: who said it, to whom, about whom, what it says (a kind from a fixed set), whether it is TRUE and what the speaker really
 * MEANT by it. The narrator only words a claim, and only one the player hears as its listener (`claimsHeardBy`), as the speaker's words:
 * never its truth, never the intent.
 *
 * Delivering a claim to an NPC writes the listener's BELIEF (beliefStore.ts) with the speaker as its source, at the speaker's reliability in
 * the listener's eyes (the same trust-to-confidence rule as heard-about-me, B24). A false claim plants a false belief like any other; only
 * this log knows it was a lie. The player is handed no belief: the read is the player's own (0017/0020).
 *
 * Pure rules: no I/O, no rng (the CALLER decides the claim, its truth and its intent), so it is calibration-neutral until a caller exists.
 * ENGINE-ONLY (Vault class): `ClaimLog` rides on `LiveSeasonState.claims`, is never projected, and is append-only for the season (never thinned).
 *
 * SEAMS for Ryne's open theme 2 questions (each answer that differs is a change in ONE place here):
 *  - Q1 lie content: the engine picks from `SPOKEN_CLAIM_KINDS` (a fixed set) -> change the catalog / `beliefFor`.
 *  - Q3 tells: `claimsHeardBy` is the ONLY outward projection and carries no truth, intent or tell -> a tell would be a field added there.
 *  - Q4 NPC to NPC from the start: `CLAIM_RULES.npcToNpc` -> false refuses claims where the player is neither speaker nor listener.
 *  - Q6 narrator promises/claims: every claim here is `origin: "engine"`; slice 6 adds `"narrated"` claims from the open ledger.
 *  - Q2 belief strength is slice 2 (how strongly the beliefs written here steer decisions); this slice only writes them.
 */

/** The fixed set of things a houseguest can claim (Q1). `subject` is who the claim is about; `object` the second party where the kind has one. */
export const SPOKEN_CLAIM_KINDS = [
  "targets-you",        // subject is targeting the listener
  "voted-to-evict-you", // subject voted to evict the listener
  "final-two-with",     // subject has a final two with object
  "going-after",        // subject is going after object
  "talking-about",      // subject has been talking about object behind their back
  "lying-about",        // subject is lying to object (to the listener when object is absent)
  "voted-against",      // subject voted to evict object (0153: so "they voted against ME" - the speaker - can be said; ORW-330 slice 3, asked for by slice 4)
  "voted-to-keep",      // subject voted to KEEP object (did not vote to evict them): "I voted to keep you" (0153, for slice 5's vote lies)
] as const;
export type SpokenClaimKind = typeof SPOKEN_CLAIM_KINDS[number];

const NEEDS_OBJECT: ReadonlySet<SpokenClaimKind> = new Set(["final-two-with", "going-after", "talking-about", "voted-against", "voted-to-keep"]);
const ABOUT_LISTENER: ReadonlySet<SpokenClaimKind> = new Set(["targets-you", "voted-to-evict-you"]);
/** 0153: the kinds a speaker may tell about THEMSELVES - their own ballot ("I voted to keep you", "I voted against them"); slice 5 lies about it. */
const ABOUT_OWN_VOTE: ReadonlySet<SpokenClaimKind> = new Set(["voted-to-keep", "voted-against"]);

/** What the speaker really meant by it (engine-only, like ORW-305's real reason): never handed to the narrator. */
export type ClaimIntent = "inform" | "warn" | "recruit" | "mislead" | "deflect" | "protect";
export const CLAIM_INTENTS: readonly ClaimIntent[] = ["inform", "warn", "recruit", "mislead", "deflect", "protect"];

export const CLAIM_RULES = {
  /** Q4 (assumed yes, Ryne 11-11 "lies and spreading information are the biggest tools"): NPCs tell each other claims, off-screen. */
  npcToNpc: true,
} as const;

export interface SpokenClaim {
  /** `claim:<seq>` - unique and stable for the season. */
  id: string;
  speaker: EntityId;
  listener: EntityId;
  kind: SpokenClaimKind;
  subject: EntityId;
  object?: EntityId;
  week: number;
  day?: number;
  /** The engine's truth: false means the speaker lied. Engine-only. */
  isTrue: boolean;
  /** What the speaker really meant by it. Engine-only. */
  intent: ClaimIntent;
  /** Q6 seam: who decided the claim. "engine": the engine chose it. "narrated" (0155, slice 6): the narrator wrote it on its own and the open ledger handed it to the engine, which gave it its truth. */
  origin: "engine" | "narrated";
}

/** The season's claims, oldest first. Append-only. Engine-only (rides on `LiveSeasonState.claims`). */
export interface ClaimLog { seq: number; items: SpokenClaim[] }

export interface ClaimInput {
  speaker: EntityId; listener: EntityId; kind: SpokenClaimKind; subject: EntityId; object?: EntityId;
  isTrue: boolean; intent: ClaimIntent;
  /** 0155: set to "narrated" for a claim the open ledger caught; absent = an engine claim. */
  origin?: "narrated";
}

export interface ClaimContext {
  week: number;
  day?: number;
  /** The houseguests in the house (the speaker, listener, subject and object must all be among them). */
  living: readonly EntityId[];
  /** The listener's trust in the speaker, 0..1 (the hidden relationship edge). */
  trustOf: (listener: EntityId, speaker: EntityId) => number;
  /** Does the listener credit the speaker as someone who keeps their word (0121)? */
  credited?: (listener: EntityId, speaker: EntityId) => boolean;
  /** 0160 (conviction): how readily the listener believes what they are told, 0..1 (0.5 = at the source's word). Absent = 0.5 (unchanged). */
  credulity?: (listener: EntityId) => number;
}

/** Why a claim is refused (a programming error in the caller, never a game event). Undefined = valid. */
export function claimProblem(c: ClaimInput, living: readonly EntityId[]): string | undefined {
  if (!(SPOKEN_CLAIM_KINDS as readonly string[]).includes(c.kind)) return "unknown kind";
  if (!CLAIM_INTENTS.includes(c.intent)) return "unknown intent";
  const inHouse = (id: EntityId | undefined) => id !== undefined && living.includes(id);
  if (!inHouse(c.speaker) || !inHouse(c.listener) || !inHouse(c.subject)) return "not in the house";
  if (c.speaker === c.listener) return "speaker is the listener";
  if (c.subject === c.speaker && !ABOUT_OWN_VOTE.has(c.kind)) return "a claim is about someone else"; // a houseguest may claim their OWN vote ("I voted to keep you")
  if (ABOUT_LISTENER.has(c.kind) && c.subject === c.listener) return "a claim is about someone else";
  if (NEEDS_OBJECT.has(c.kind)) {
    if (!inHouse(c.object) || c.object === c.subject) return "needs a second houseguest";
  } else if (c.object !== undefined && (c.kind !== "lying-about" || !inHouse(c.object) || c.object === c.subject)) return "unexpected second houseguest";
  if (!CLAIM_RULES.npcToNpc && c.speaker !== PLAYER && c.listener !== PLAYER) return "npc-to-npc claims are off";
  return undefined;
}

/** The belief a claim plants in its listener: the belief kind, subject and object (Q1: one mapping per claim kind). */
export function beliefFor(c: Pick<SpokenClaim, "kind" | "listener" | "subject" | "object">): { kind: ClaimKind; subject: EntityId; object?: EntityId; nature?: string } {
  switch (c.kind) {
    case "targets-you": return { kind: "targets-me", subject: c.subject, object: c.listener };
    case "voted-to-evict-you": return { kind: "voted-against-me", subject: c.subject };
    case "final-two-with": return { kind: "allied-with", subject: c.subject, object: c.object };
    case "going-after": return { kind: "heard-rumor", subject: c.subject, object: c.object, nature: "going-after" };
    case "talking-about": return { kind: "heard-rumor", subject: c.subject, object: c.object, nature: "talking-about" };
    case "voted-to-keep":
      return c.object === c.listener
        ? { kind: "assured-me", subject: c.subject }
        : { kind: "heard-rumor", subject: c.subject, object: c.object, nature: "voted-to-keep" };
    case "voted-against":
      return c.object === c.listener
        ? { kind: "voted-against-me", subject: c.subject }
        : { kind: "heard-rumor", subject: c.subject, object: c.object, nature: "voted-against" };
    case "lying-about":
      return c.object === undefined || c.object === c.listener
        ? { kind: "lied-to-me", subject: c.subject }
        : { kind: "heard-rumor", subject: c.subject, object: c.object, nature: "lying" };
  }
}

/** The confidence a listener holds a claim at: the speaker's reliability in their eyes (trust, plus the word-keeper bonus), as for B24. */
export function claimConfidence(trustInSpeaker: number, credited: boolean): number {
  return heardConfidence(tellerReliability(trustInSpeaker, credited));
}

/**
 * Tell a claim: append it to the log and, when the listener is an NPC and a belief layer exists, write the listener's belief (source = the
 * speaker). Returns the recorded claim, or undefined when the claim is refused (`claimProblem`). The belief is written even when the claim is
 * false: the listener cannot tell (Q3 - no built-in tells).
 */
export function tellClaim(log: ClaimLog, beliefs: BeliefStore | undefined, input: ClaimInput, ctx: ClaimContext): SpokenClaim | undefined {
  if (claimProblem(input, ctx.living) !== undefined) return undefined;
  log.seq += 1;
  const claim: SpokenClaim = {
    id: `claim:${log.seq}`, speaker: input.speaker, listener: input.listener, kind: input.kind, subject: input.subject,
    ...(input.object !== undefined ? { object: input.object } : {}),
    week: ctx.week, ...(ctx.day !== undefined ? { day: ctx.day } : {}),
    isTrue: input.isTrue, intent: input.intent, origin: input.origin ?? "engine",
  };
  log.items.push(claim);
  if (beliefs && claim.listener !== PLAYER) {
    const b = beliefFor(claim);
    const fromSource = claimConfidence(ctx.trustOf(claim.listener, claim.speaker), ctx.credited?.(claim.listener, claim.speaker) ?? false);
    const confidence = ctx.credulity ? convictionFor(fromSource, ctx.credulity(claim.listener)) : fromSource; // 0160: the listener's own credulity
    recordClaim(beliefs, {
      id: `${claim.listener}|${b.kind}|${b.subject}|${claim.id}`, holder: claim.listener, kind: b.kind, subject: b.subject,
      ...(b.object !== undefined ? { object: b.object } : {}), ...(b.nature !== undefined ? { nature: b.nature } : {}),
      value: true, origin: "told", source: claim.speaker, confidence, week: claim.week,
    });
  }
  return claim;
}

/** A claim as its listener heard it: the speaker's words and nothing the engine knows behind them. */
export interface HeardClaim {
  speaker: EntityId;
  kind: SpokenClaimKind;
  subject: EntityId;
  object?: EntityId;
  week: number;
  day?: number;
}

/**
 * THE outward projection (the narrator seam, wired in slice 4): the claims `listener` heard, as the speaker's words. Built field by field, so
 * the truth and the intent can never ride along. Only the player's own heard claims are ever asked for outward.
 */
export function claimsHeardBy(log: ClaimLog | undefined, listener: EntityId): HeardClaim[] {
  return (log?.items ?? []).filter((c) => c.listener === listener).map((c) => ({
    speaker: c.speaker, kind: c.kind, subject: c.subject,
    ...(c.object !== undefined ? { object: c.object } : {}),
    week: c.week, ...(c.day !== undefined ? { day: c.day } : {}),
  }));
}

/** The lies `speaker` has told, oldest first (engine-only; the retrospective door is slice 8). */
export function liesBy(log: ClaimLog | undefined, speaker: EntityId): readonly SpokenClaim[] {
  return (log?.items ?? []).filter((c) => c.speaker === speaker && !c.isTrue);
}
