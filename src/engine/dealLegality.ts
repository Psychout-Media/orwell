import type { EntityId } from "../domain/ids";
import type { DealKind } from "../domain/deal";

/**
 * ORW-727 - a deal term must fit the powers its giver really holds this week. PURE: no I/O, no rng, no wording. The engine fixes legality (a closed-set rule, ADR 0005); the narrator voices.
 *
 * A promise to VOTE to keep someone safe at this week's eviction is only keepable when the giver has a vote (the HOH votes only to break a tie, nominees do not vote, and at the final
 * eviction the Final HOH alone decides) AND the person it protects is actually exposed to that eviction (a nominee, or anyone while the nominations are still ahead - never the HOH, never a
 * houseguest who stayed off the block once the nominations are made).
 */
export interface DealWeek {
  hoh?: EntityId;
  /** The nominees as they stand (after the veto, the final ones). Empty before the nominations. */
  nominees: readonly EntityId[];
  /** True once the nominations are made this week. */
  nominationsMade: boolean;
  /** True when this week's eviction has no ballot at all (the Final HOH's lone decision). */
  noBallot?: boolean;
}

export type DealIllegalReason = "no-vote-power" | "not-at-risk" | "already-live";

/** Can `giver` keep a promise to vote to keep `beneficiary` safe at this week's eviction? Undefined when yes. */
export function voteTermIllegal(giver: EntityId, beneficiary: EntityId, w: DealWeek): DealIllegalReason | undefined {
  if (w.noBallot === true || giver === w.hoh || (w.nominationsMade && w.nominees.includes(giver))) return "no-vote-power";
  if (beneficiary === w.hoh || (w.nominationsMade && !w.nominees.includes(beneficiary))) return "not-at-risk";
  return undefined;
}

/**
 * The legality of a whole deal between two parties. Only the `vote` kind carries the vote-to-keep-safe term; every other kind is legal here. A mutual vote deal stands when AT LEAST ONE
 * direction can be kept (the other side's promise is then merely idle); when neither can, it is refused with the first direction's reason.
 */
export function dealTermIllegal(kind: DealKind, a: EntityId, b: EntityId, w: DealWeek): DealIllegalReason | undefined {
  if (kind !== "vote") return undefined;
  const ab = voteTermIllegal(a, b, w), ba = voteTermIllegal(b, a, w);
  return ab !== undefined && ba !== undefined ? ab : undefined;
}

/** Week-scoped kinds that a second live deal between the same pair would only duplicate. */
const DEDUPED_KINDS: ReadonlySet<DealKind> = new Set<DealKind>(["safety", "vote", "final-two"]);

export interface LiveDealRef { id: string; parties: readonly EntityId[]; kind: DealKind; status: string; madeWeek?: number }

/** The live deal that a new `kind` deal between `a` and `b` this `week` would duplicate (same pair, same kind, still open; a week-scoped kind must be from the same week). */
export function duplicateLiveDeal(deals: readonly LiveDealRef[], kind: DealKind, a: EntityId, b: EntityId, week: number, exceptId?: string): LiveDealRef | undefined {
  if (!DEDUPED_KINDS.has(kind)) return undefined;
  return deals.find((d) => d.status === "open" && d.id !== exceptId && d.kind === kind && d.parties.includes(a) && d.parties.includes(b)
    && (kind === "final-two" || d.madeWeek === undefined || d.madeWeek === week));
}
