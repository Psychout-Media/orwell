import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";
import { caughtLieTrustDrop } from "./caughtLies";

/**
 * Feature 0203 (Theme 4, ORW-646; Ryne 2026-11-17) - COMING CLEAN, NUANCED. FOUNDATION ONLY: the claim-level types and pure rules the build (A or B) wires into the
 * adapter. Pure: no I/O, no rng, no Vault. Engine-only: nothing here is ever shown as a number.
 *
 *  - CONFESS: a speaker tells a listener that a claim they told them was false, BEFORE it is caught. It costs less than being caught: a smaller trust drop, and no
 *    `lied-to-me` belief (an owned lie is not a caught one, so no credibility hit and no revenge goal). The planted belief is refuted.
 *  - LOOP IN: a speaker tells an ALLY the truth about a lie they told someone else. A trust move with the ally (shared complicity), and a risk: the ally now holds
 *    "the speaker lied to X" as a fact, which can travel by gossip back to X (who then catches it the usual way).
 *  - LAYERED LIES: different listeners get different versions about one subject, and different confessions. Tracked claim by claim (every act names a claim id), so
 *    the engine always knows who was told what, who was told the truth, and by whom.
 * NPCs do all of this engine-decided (`confessChance` from their own read of the catch risk and their candor); the player does it in play (levers in the build).
 */
export const COMING_CLEAN = {
  /** Confessing first costs this share of the trust a caught lie would (at full evidence). */
  confessShare: 0.35,
  /** Looping an ally in raises their trust in the speaker this much, at full closeness (complicity). */
  loopInTrust: 0.05,
  /** The ally then holds "the speaker lied to X" at this confidence: a held fact (above the 0.7 bar of fact), so it can be passed on. */
  loopInConfidence: 0.9,
  /** An NPC liar's chance (per decision point) to confess a lie to its listener is at most this. */
  confessMax: 0.6,
  /** The catch risk a liar reads, weights: another version told about the same subject to someone the listener is close to; the listener already doubting; the subject close to the listener. */
  risk: { otherVersion: 0.35, doubting: 0.3, subjectClose: 0.25 },
} as const;

/** One coming-clean act, always naming the claim it is about. Append-only (the record never loses an act). */
export type CleanAct =
  | { kind: "confess"; by: EntityId; to: EntityId; claimId: string; week: number }
  | { kind: "loop-in"; by: EntityId; to: EntityId; claimId: string; toldTo: EntityId; week: number };

/** The minimal claim slice the rules read (a SpokenClaim fits). */
export interface CleanClaim { id: string; speaker: EntityId; listener: EntityId; kind: string; subject: EntityId; object?: EntityId; isTrue: boolean }

/** Can `claim` still be confessed to its listener: a lie, not yet caught, not already confessed to them? */
export function confessable(claim: CleanClaim, caught: ReadonlySet<string>, acts: readonly CleanAct[]): boolean {
  if (claim.isTrue || caught.has(claim.id)) return false;
  return !acts.some((a) => a.kind === "confess" && a.claimId === claim.id && a.to === claim.listener);
}

/** The trust a confession costs the confessor in the listener's eyes: a share of a caught lie's cost at full evidence. */
export const confessionTrustDrop = (): number => COMING_CLEAN.confessShare * caughtLieTrustDrop(1);

/** The trust an ally gains in the speaker for being looped in, by how close they already were (0..1). */
export const loopInTrustGain = (closeness: number): number => COMING_CLEAN.loopInTrust * clamp01(closeness);

/** The catch risk a liar reads for one lie (0..1), from what THEY can see. */
export function catchRisk(i: { otherVersionNearListener: boolean; listenerDoubting: boolean; subjectCloseToListener: boolean }): number {
  const r = COMING_CLEAN.risk;
  return clamp01((i.otherVersionNearListener ? r.otherVersion : 0) + (i.listenerDoubting ? r.doubting : 0) + (i.subjectCloseToListener ? r.subjectClose : 0));
}

/** An NPC liar's chance to confess first: rises with the risk they read and their candor (0..1), capped. The caller rolls once on its own keyed side stream. */
export const confessChance = (risk: number, candor: number): number => Math.min(COMING_CLEAN.confessMax, clamp01(risk) * (0.5 + 0.5 * clamp01(candor)));

/** Layered lies: every version one speaker told about one subject, per listener, oldest first, with any confession or loop-in on it. For the build and the post-crown retrospective. */
export function versionsAbout(claims: readonly CleanClaim[], speaker: EntityId, subject: EntityId, acts: readonly CleanAct[]): Array<{ claim: CleanClaim; confessedTo: EntityId[]; loopedIn: EntityId[] }> {
  return claims.filter((c) => c.speaker === speaker && c.subject === subject).map((claim) => ({
    claim,
    confessedTo: acts.filter((a) => a.kind === "confess" && a.claimId === claim.id).map((a) => a.to),
    loopedIn: acts.filter((a) => a.kind === "loop-in" && a.claimId === claim.id).map((a) => a.to),
  }));
}
