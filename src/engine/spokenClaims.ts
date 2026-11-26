import type { EntityId } from "../domain/ids";
import { isRoleLabel } from "./socialRoles";
import { PLAYER } from "../domain/ids";
import { evidenceKey, recordClaim, type BeliefStore, type ClaimKind } from "./beliefStore";
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
  "has-reputation",     // 0184 part 2a: the subject has a name in the house as `label` (a social role or a reputation), in the speaker's own words; may be about the listener ("everyone thinks you're the snake")
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
  /** 0184 part 2a: the label of a `has-reputation` claim. */
  label?: string;
  week: number;
  day?: number;
  /** The engine's truth: false means the speaker lied. Engine-only. */
  isTrue: boolean;
  /** What the speaker really meant by it. Engine-only. */
  intent: ClaimIntent;
  /** Q6 seam: who decided the claim. "engine": the engine chose it. "narrated" (0155, slice 6): the narrator wrote it on its own and the open ledger handed it to the engine, which gave it its truth. */
  origin: "engine" | "narrated" | "player";
}

/** The season's claims, oldest first. Append-only. Engine-only (rides on `LiveSeasonState.claims`). */
export interface ClaimLog { seq: number; items: SpokenClaim[] }

export interface ClaimInput {
  speaker: EntityId; listener: EntityId; kind: SpokenClaimKind; subject: EntityId; object?: EntityId;
  /** 0184 part 2a: for `has-reputation`, the role or reputation said (an engine `RoleLabel`, voiced by the narrator in its own words). */
  label?: string;
  isTrue: boolean; intent: ClaimIntent;
  /** 0155: set to "narrated" for a claim the open ledger caught; absent = an engine claim. */
  origin?: "narrated" | "player";
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
  /** ORW-587 (T2-4): how far the listener believes THIS speaker's word, 0..1 (1 = never caught lying; from the listener's own caught-lie record, B48). Scales the belief's confidence. Absent = 1 (unchanged). */
  credibility?: (listener: EntityId, speaker: EntityId) => number;
  /** ORW-618 (0189 part 2): the jurors (and the player only as a juror) when the claim is told in the jury house; see `claimProblem`. Absent = the house. */
  jury?: readonly EntityId[];
}

/** Why a claim is refused (a programming error in the caller, never a game event). Undefined = valid. */
export function claimProblem(c: ClaimInput, living: readonly EntityId[], jury?: readonly EntityId[]): string | undefined {
  if (!(SPOKEN_CLAIM_KINDS as readonly string[]).includes(c.kind)) return "unknown kind";
  if (!CLAIM_INTENTS.includes(c.intent)) return "unknown intent";
  // ORW-618 (0189 part 2): the SEQUESTER. In the jury house (`jury` given, the jurors, and the player only when the player IS a juror) a claim may pass ONLY between two jurors; a juror never speaks to
  // or hears from anyone still in the house. What a claim is ABOUT may still be a houseguest in the house (jurors talk about the finalists). Absent `jury` = exactly the house rule.
  const pair = jury !== undefined && jury.includes(c.speaker) && jury.includes(c.listener);
  const inHouse = (id: EntityId | undefined) => id !== undefined && (living.includes(id) || (pair && jury!.includes(id)));
  const inRoom = (id: EntityId): boolean => (pair ? jury!.includes(id) : living.includes(id));
  if (!inRoom(c.speaker) || !inRoom(c.listener) || !inHouse(c.subject)) return "not in the house";
  if (c.speaker === c.listener) return "speaker is the listener";
  if (c.kind === "has-reputation" && !isRoleLabel(c.label)) return "a reputation needs a role"; // 0184 part 2a: only the engine's own role words
  if (c.subject === c.speaker && !ABOUT_OWN_VOTE.has(c.kind)) return "a claim is about someone else"; // a houseguest may claim their OWN vote ("I voted to keep you")
  if (ABOUT_LISTENER.has(c.kind) && c.subject === c.listener) return "a claim is about someone else";
  if (NEEDS_OBJECT.has(c.kind)) {
    if (!inHouse(c.object) || c.object === c.subject) return "needs a second houseguest";
  } else if (c.object !== undefined && (c.kind !== "lying-about" || !inHouse(c.object) || c.object === c.subject)) return "unexpected second houseguest";
  if (!CLAIM_RULES.npcToNpc && c.speaker !== PLAYER && c.listener !== PLAYER) return "npc-to-npc claims are off";
  return undefined;
}

/** The belief a claim plants in its listener: the belief kind, subject and object (Q1: one mapping per claim kind). */
export function beliefFor(c: Pick<SpokenClaim, "kind" | "listener" | "subject" | "object" | "label">): { kind: ClaimKind; subject: EntityId; object?: EntityId; nature?: string } {
  switch (c.kind) {
    case "has-reputation": return { kind: "heard-rumor", subject: c.subject, nature: reputationNature(c.label ?? "") };
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

/** 0184 part 2a: a heard reputation is held as a heard rumor whose nature carries the label (`rep:<label>`); no new belief field. */
export const REPUTATION_NATURE_PREFIX = "rep:";
export const reputationNature = (label: string): string => `${REPUTATION_NATURE_PREFIX}${label}`;
export const labelOfNature = (nature: string | undefined): string | undefined => (nature?.startsWith(REPUTATION_NATURE_PREFIX) ? nature.slice(REPUTATION_NATURE_PREFIX.length) : undefined);

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
  if (claimProblem(input, ctx.living, ctx.jury) !== undefined) return undefined;
  // ORW-931 (Fable W2-7): the SAME speaker saying the same thing to the PLAYER again is not a new telling (parity with an NPC listener, ORW-591 below: a same-speaker repeat is
  // never fresh proof). Nothing is logged and nothing reaches the narrator, so it cannot read as news. A DIFFERENT speaker is corroboration and is told (the caller marks it
  // `alreadyHeard` for the narrator).
  if (input.listener === PLAYER && log.items.some((c) => c.listener === PLAYER && c.speaker === input.speaker && sameClaimKey(c, input))) return undefined;
  log.seq += 1;
  const claim: SpokenClaim = {
    id: `claim:${log.seq}`, speaker: input.speaker, listener: input.listener, kind: input.kind, subject: input.subject,
    ...(input.object !== undefined ? { object: input.object } : {}), ...(input.label !== undefined ? { label: input.label } : {}),
    week: ctx.week, ...(ctx.day !== undefined ? { day: ctx.day } : {}),
    isTrue: input.isTrue, intent: input.intent, origin: input.origin ?? "engine",
  };
  log.items.push(claim);
  if (beliefs && claim.listener !== PLAYER) {
    const b = beliefFor(claim);
    const fromSource = claimConfidence(ctx.trustOf(claim.listener, claim.speaker), ctx.credited?.(claim.listener, claim.speaker) ?? false);
    const convinced = ctx.credulity ? convictionFor(fromSource, ctx.credulity(claim.listener)) : fromSource; // 0160: the listener's own credulity
    const confidence = ctx.credibility ? convinced * Math.max(0, Math.min(1, ctx.credibility(claim.listener, claim.speaker))) : convinced; // ORW-587: a speaker the listener caught lying lands weaker
    const planted = {
      id: `${claim.listener}|${b.kind}|${b.subject}|${claim.id}`, holder: claim.listener, kind: b.kind, subject: b.subject,
      ...(b.object !== undefined ? { object: b.object } : {}), ...(b.nature !== undefined ? { nature: b.nature } : {}),
      value: true, origin: "told" as const, source: claim.speaker, confidence, week: claim.week,
    };
    // ORW-591 (Fable T2-8): the same speaker saying the same thing again is NOT fresh proof. It folds into the belief they already planted (still
    // believed, not let go): the newer week and the higher confidence are kept (never lowered), and the telling's id is remembered so a lie caught on
    // it still finds this belief. A DIFFERENT speaker saying it is real corroboration and plants its own belief (`pathwayEvidence`, `believedGrievance`).
    const key = evidenceKey(planted);
    const same = (beliefs[claim.listener] ?? []).find((x) => x.value && !x.refuted && evidenceKey(x) === key);
    if (same) {
      same.confidence = Math.max(same.confidence, confidence);
      same.week = Math.max(same.week, claim.week);
      (same.alsoClaims ??= []).push(claim.id);
    } else recordClaim(beliefs, planted);
  }
  return claim;
}

/** ORW-931: two tellings say the same thing (kind, who, the second party, a reputation's label), whoever said them. */
export function sameClaimKey(a: { kind: string; subject: EntityId; object?: EntityId; label?: string }, b: { kind: string; subject: EntityId; object?: EntityId; label?: string }): boolean {
  return a.kind === b.kind && a.subject === b.subject && (a.object ?? "") === (b.object ?? "") && (a.label ?? "") === (b.label ?? "");
}

/** ORW-591 (Fable T2-8) - the save check's rule for the claim log (append-only, never thinned): no claim told is ever lost, and the id counter never goes back. */
export function claimLogSuperset(later: ClaimLog | undefined, earlier: ClaimLog | undefined): boolean {
  if (!earlier || (earlier.items.length === 0 && earlier.seq === 0)) return true;
  if (!later || later.seq < earlier.seq) return false;
  const ids = new Set(later.items.map((c) => c.id));
  return earlier.items.every((c) => ids.has(c.id));
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
