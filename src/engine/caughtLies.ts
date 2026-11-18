import type { EntityId } from "../domain/ids";
import { plantedBy, refuteClaim, type BeliefStore } from "./beliefStore";

type MutableEdge = { trust: number; affinity: number; threat: number };

/**
 * Feature 0154 / ORW-330 (theme 2, slice 5a) - CAUGHT IN A LIE. Pure checks (no I/O, no rng, no Vault) that decide whether what a speaker SAID to a
 * listener is clashed with by what the board then shows. The adapter calls them at the moment the board changes and, on a hit, `catchLie`s.
 *
 * Reads the PUBLIC vote count only - never a ballot. Conservative: only CERTAIN impossibilities and contradictions are caught; a claim the board
 * cannot settle is left believed. Confidence of a caught lie is the strength of the evidence (`CAUGHT_LIE`), on the 0..1 belief confidence scale
 * (no second scale; how hard it then bites is `BELIEF_RULES.strength` / B48, unchanged).
 *
 * `voted-to-keep` (subject voted to KEEP object; 0153) is the kind trigger 1 reads.
 */
export const CAUGHT_LIE = {
  /** The public count makes the claim impossible. */
  impossible: 0.97, // a certainty (a public count rules the claim out): clears the 0150 revenge bar (0.75) at the lied-to-me weight 0.8
  /** Two claims by one speaker to one listener cannot both be true. */
  contradiction: 0.8,
  /**
   * ORW-616 ("all 4 equal"): the trust a caught lie costs the liar in the catcher's eyes, at full evidence (scaled by the evidence's confidence). The SAME for the player and
   * for a houseguest. Sized between a broken casual assurance (`ASSURANCE.brokenTrustDrop` 0.12) and a broken formal deal (`BETRAYAL_SHOCK` trust 0.32): a lie is worse than
   * a lapsed promise and not as bad as a broken deal. Rng-free and trust-only; the lie's other bite is the `lied-to-me` claim itself (credibility, B48; revenge, 0150).
   */
  trustDrop: 0.2,
  /** ORW-594 (Fable T2-13): more "I voted to keep them" claims reached one listener than the public count has keep votes, so some of them lied; the listener suspects the
   *  ones they trust least. A deduction (it can be wrong), so below a certainty and below the 0150 revenge bar on its own. */
  counting: 0.6,
} as const;

/** ORW-616: how much trust a caught lie costs, from the confidence of the evidence that caught it (0..1). Rng-free, bounded by `CAUGHT_LIE.trustDrop`. */
export function caughtLieTrustDrop(confidence: number): number {
  const c = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  return CAUGHT_LIE.trustDrop * c;
}

/** The public face of a finished eviction count: who left, how many votes read "evict", and who was eligible to vote. Never who voted for what. */
export interface PublicTally { evictee: EntityId; evictVotes: number; voters: readonly EntityId[] }

/** The slice of a claim these checks read. */
export interface ClaimLike { id?: string; speaker: EntityId; listener: EntityId; kind: string; subject: EntityId; object?: EntityId }

/**
 * Does the PUBLIC count make "<subject> voted to keep <object>" impossible? Only a unanimous count does: if every eligible voter voted to evict the
 * evictee, no voter kept them. A count with any "keep" in it settles nothing about who. Not a keep-vote claim, a subject who was not a voter, or a
 * keep of anyone but the evictee => false (conservative). The speaker may be the subject ("I voted to keep you") or a third party.
 */
export function voteCountRulesOut(tally: PublicTally, claim: ClaimLike): boolean {
  if (claim.kind !== "voted-to-keep" || claim.object === undefined) return false;
  if (!tally.voters.includes(claim.subject)) return false;
  return claim.object === tally.evictee && tally.voters.length > 0 && tally.evictVotes >= tally.voters.length;
}

/**
 * ORW-594 (Fable T2-13): CATCH BY COUNTING. The claims one listener heard this eviction that a voter kept the evictee (`voted-to-keep`, object = the evictee),
 * counted by distinct voter. The public count says how many keep votes exist (voters - evict votes); if more voters claimed to keep the evictee than that,
 * at least the excess lied. The listener cannot know which: they suspect the ones they trust least (`trustOf`, ties by id). Returns those suspected (empty when
 * the claims fit the count). Reads the public count and the claims the listener was told - never a ballot.
 */
export function overclaimedKeeps(tally: PublicTally, heard: readonly ClaimLike[], trustOf: (subject: EntityId) => number): EntityId[] {
  const claimants = [...new Set(heard.filter((c) => c.kind === "voted-to-keep" && c.object === tally.evictee && tally.voters.includes(c.subject)).map((c) => c.subject))];
  const keepVotes = Math.max(0, tally.voters.length - tally.evictVotes);
  const excess = claimants.length - keepVotes;
  if (excess <= 0) return [];
  return claimants.sort((a, b) => trustOf(a) - trustOf(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, excess);
}

const pairKey = (a: EntityId, b: EntityId): string => [a, b].sort().join("|");

/**
 * Can these two claims by ONE speaker to ONE listener not both be true? A small table over the fixed kinds:
 *  - final-two-with(a, b) vs going-after on the same pair (either direction): you do not plan a final two with someone you are going after;
 *  - voted-to-keep(x) vs voted-against(speaker -> x): one voter cannot have both kept and evicted the same houseguest (same subject and object).
 * Different speaker or listener => false.
 */
export function contradicts(a: ClaimLike, b: ClaimLike): boolean {
  if (a.speaker !== b.speaker || a.listener !== b.listener) return false;
  const ft = (c: ClaimLike): boolean => c.kind === "final-two-with" && c.object !== undefined;
  const ga = (c: ClaimLike): boolean => c.kind === "going-after" && c.object !== undefined;
  if ((ft(a) && ga(b)) || (ga(a) && ft(b))) return pairKey(a.subject, a.object!) === pairKey(b.subject, b.object!);
  const keep = (c: ClaimLike): boolean => c.kind === "voted-to-keep" && c.object !== undefined;
  const against = (c: ClaimLike): boolean => c.kind === "voted-against" && c.object !== undefined;
  if ((keep(a) && against(b)) || (against(a) && keep(b))) return a.subject === b.subject && a.object === b.object;
  return false;
}

/**
 * The ONE shared way to take back the belief a claim planted: `refuteClaim` (reverses any recorded edge impact) AND `refuted = true` (a claim told
 * by `tellClaim` carries no edge impact, so `refuteClaim` alone would leave it standing). Id kept. Returns whether a belief was marked.
 * The planted belief's id is `<holder>|<kind>|<subject>|<claimId>`.
 */
export function refuteToldBelief(store: BeliefStore | undefined, holder: EntityId, claimId: string, edgeOf: (h: EntityId, s: EntityId) => MutableEdge): boolean {
  const belief = store?.[holder]?.find((c) => plantedBy(c, claimId)); // ORW-591: a repeat folded into an earlier telling's belief is found there
  if (!store || !belief || belief.refuted) return false;
  refuteClaim(store, holder, belief.id, edgeOf);
  belief.refuted = true;
  return true;
}

/**
 * ORW-646 (0203) - a belief TAKEN BACK by its teller (a confession) is dated to the retraction, not to the telling, and filed last. The per-holder cap
 * lets go of the OLDEST refuted belief first (`compactionVictim`); a belief confessed away in a window would otherwise be older than every belief
 * already refuted and be the first the cap takes, ahead of them, while a live belief of the holder was never at risk: the save check (`beliefStoreSuperset`)
 * reads that as a refuted belief surviving while a live one went. Dated to the retraction it queues behind the older refutations (and, on a tie of weeks,
 * behind them by position), so the cap lets go of those first. The id, the planted claim, `refuted` and `reversed` are untouched. Returns whether it moved.
 */
export function dateRetraction(store: BeliefStore | undefined, holder: EntityId, claimId: string, week: number): boolean {
  const list = store?.[holder];
  const at = list?.findIndex((c) => plantedBy(c, claimId) && c.refuted === true) ?? -1;
  if (!list || at < 0) return false;
  const [b] = list.splice(at, 1);
  list.push({ ...b!, week: Math.max(b!.week, week) });
  return true;
}
