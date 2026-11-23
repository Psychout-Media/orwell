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
  /** A pair this close (0..1, trust and affinity) counts as near: the bar for "another version reached someone close to the listener" and "the subject is close to the listener". */
  nearBond: 0.6,
  /** A listener whose belief in the lie sits below this already doubts it (an open test). */
  doubtBelow: 0.5,
  /** The bond both ways an ally needs before a liar will loop them in. */
  allyBond: 0.6,
  /** An NPC liar who does not confess loops an ally in at this share of the confess chance. */
  loopInShare: 0.5,
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

/** The save check's rule for the record (append-only, never thinned): no coming-clean act is ever lost. */
export function cleanActsSuperset(later: readonly CleanAct[] | undefined, earlier: readonly CleanAct[] | undefined): boolean {
  if (!earlier || earlier.length === 0) return true;
  const key = (a: CleanAct): string => `${a.kind}|${a.by}|${a.to}|${a.claimId}|${a.kind === "loop-in" ? a.toldTo : ""}`;
  const have = new Set((later ?? []).map(key));
  return earlier.every((a) => have.has(key(a)));
}

/** Has this act already been done (a confession once per claim and listener; a loop-in once per claim and ally)? */
export function cleanActDone(acts: readonly CleanAct[], a: { kind: CleanAct["kind"]; claimId: string; to: EntityId }): boolean {
  return acts.some((x) => x.kind === a.kind && x.claimId === a.claimId && x.to === a.to);
}

/**
 * Does the NPC liar read a SECOND version of this lie as near the listener? Another claim by the same speaker about the same subject, told to someone else
 * (a different listener) whom the listener is close to. `closeTo` is the caller's read of the pair's bond (0..1).
 */
export function otherVersionNear(claims: readonly CleanClaim[], claim: CleanClaim, closeTo: (a: EntityId, b: EntityId) => number, bar: number): boolean {
  return claims.some((c) => c.id !== claim.id && c.speaker === claim.speaker && c.subject === claim.subject && c.listener !== claim.listener && closeTo(c.listener, claim.listener) >= bar);
}

/**
 * ORW-747 - the coming-clean record for the post-crown retrospective: `versionsAbout` for every liar and subject where at least one of the liar's versions was
 * confessed or looped in (the acts that make a story). Pure, deterministic (liar, then subject, then the claim log's order), names only through `nameOf`;
 * `say` is the engine's own claim wording (the narrator words the scene from it). The caller holds the crown gate.
 */
export function buildComingCleanRetro<C extends CleanClaim & { week: number }>(claims: readonly C[], acts: readonly CleanAct[], nameOf: (id: EntityId) => string, say: (c: C) => string): { stories: Array<{ liar: string; about: string; versions: Array<{ to: string; said: string; true: boolean; week: number; confessedTo: string[]; loopedIn: string[] }> }> } | undefined {
  const touched = new Set(acts.map((a) => a.claimId));
  const pairs = new Map<string, { speaker: EntityId; subject: EntityId }>();
  for (const c of claims) if (touched.has(c.id) && !c.isTrue) pairs.set(`${c.speaker}|${c.subject}`, { speaker: c.speaker, subject: c.subject });
  const keys = [...pairs.keys()].sort();
  if (!keys.length) return undefined;
  const byId = new Map(claims.map((c) => [c.id, c]));
  return {
    stories: keys.map((k) => {
      const { speaker, subject } = pairs.get(k)!;
      const versions = versionsAbout(claims, speaker, subject, acts).map((v) => {
        const c = byId.get(v.claim.id)!;
        return { to: nameOf(c.listener), said: say(c), true: c.isTrue, week: c.week, confessedTo: v.confessedTo.map(nameOf), loopedIn: v.loopedIn.map(nameOf) };
      });
      return { liar: nameOf(speaker), about: nameOf(subject), versions };
    }),
  };
}
