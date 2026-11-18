import type { EntityId } from "../domain/ids";
import type { DealKind } from "../domain/deal";
import type { BeliefStore } from "./beliefStore";

/**
 * 0186 (Theme 3 slice 14) - A DEAL EXPOSED, and RENEGOTIATED AFTER A TWIST. Pure: no rng, no I/O, no Vault handle. The adapter reads the ledger and the belief store, calls these,
 * and applies the hit through the existing betrayal fold. ENGINE-ONLY (Vault class): nothing here is ever projected, voiced or shown as a number.
 *
 * Exposure: a houseguest who holds an EXCLUSIVE promise (a final two) from someone learns that the same promiser holds another with a third houseguest. Learning is what they HOLD:
 * their own believed "allied with" claim about the pair (a told claim, an overheard pair, a witnessed scene), never the truth. Once most of the house holds it, the pair is PUBLIC and
 * every other holder of that promiser's exclusive promise re-weighs at once ("you have a final two with everyone").
 */
export const DEAL_EXPOSURE = {
  /** The hit is this share of the betrayal a plain deal break carries (a double-dealer is not a breaker yet: the promise still stands, only its trust is gone). */
  SEVERITY: 0.5,
  /** A pair is public once this share of the living houseguests (outside the pair) hold the belief about it. */
  PUBLIC_SHARE: 0.5,
} as const;

/** The deal kinds that promise to be the ONLY one. An engine key, never shown. */
const EXCLUSIVE_KINDS: ReadonlySet<DealKind> = new Set<DealKind>(["final-two"]);
export const isExclusiveKind = (kind: DealKind): boolean => EXCLUSIVE_KINDS.has(kind);

export interface LedgerDeal { id: string; parties: readonly [EntityId, EntityId]; kind: DealKind; status: string }

export interface ExposureHit {
  /** Who learns (and loses trust in the double-dealer). */
  holder: EntityId;
  /** The houseguest who promised the same thing to two people. */
  doubleDealer: EntityId;
  /** The other holder of the double-dealer's exclusive promise. */
  rival: EntityId;
  /** Idempotency key: `${holder}|${doubleDealer}|${rival}`. */
  key: string;
}

const other = (d: LedgerDeal, who: EntityId): EntityId => (d.parties[0] === who ? d.parties[1] : d.parties[0]);

/** Who holds a believed, standing "allied with" claim about this pair. */
function holdersOfPair(beliefs: BeliefStore, a: EntityId, b: EntityId, among: readonly EntityId[]): Set<EntityId> {
  const out = new Set<EntityId>();
  for (const h of among) {
    if ((beliefs[h] ?? []).some((c) => c.kind === "allied-with" && c.value && !c.refuted
      && ((c.subject === a && c.object === b) || (c.subject === b && c.object === a)))) out.add(h);
  }
  return out;
}

/**
 * Every exposure that has NOT yet been applied (`seen`). Deterministic order. The player is never a `holder` (their own read of a told claim is theirs to form); the player CAN be the
 * double-dealer, and a partner who is told lands on them.
 */
export function exposureHits(input: { deals: readonly LedgerDeal[]; beliefs: BeliefStore; living: readonly EntityId[]; npcs: readonly EntityId[]; seen: ReadonlySet<string> }): ExposureHit[] {
  const open = input.deals.filter((d) => d.status === "open" && isExclusiveKind(d.kind));
  const living = new Set(input.living);
  const dealers = [...new Set(open.flatMap((d) => [...d.parties]))].filter((p) => living.has(p)).sort();
  const hits: ExposureHit[] = [];
  const add = (holder: EntityId, doubleDealer: EntityId, rival: EntityId): void => {
    if (holder === doubleDealer || holder === rival || !input.npcs.includes(holder) || !living.has(holder)) return;
    const key = `${holder}|${doubleDealer}|${rival}`;
    if (input.seen.has(key) || hits.some((h) => h.key === key)) return;
    hits.push({ holder, doubleDealer, rival, key });
  };
  for (const d of dealers) {
    const partners = [...new Set(open.filter((x) => x.parties.includes(d)).map((x) => other(x, d)))].filter((p) => living.has(p)).sort();
    if (partners.length < 2) continue; // one final two is just a final two
    for (const rival of partners) {
      const told = holdersOfPair(input.beliefs, d, rival, input.living.filter((h) => h !== d && h !== rival));
      const bystanders = input.living.filter((h) => h !== d && h !== rival).length;
      const isPublic = bystanders > 0 && told.size >= Math.max(1, Math.ceil(bystanders * DEAL_EXPOSURE.PUBLIC_SHARE));
      for (const holder of partners) {
        if (holder === rival) continue;
        if (told.has(holder) || isPublic) add(holder, d, rival);
      }
    }
  }
  return hits;
}

/** A twist that reopens open deals on new terms. */
export type DealTwist = { kind: "hoh"; hoh: EntityId } | { kind: "double-eviction" };

/** The idempotency key of a twist in a week. */
export const twistKey = (t: DealTwist, week: number): string => (t.kind === "hoh" ? `hoh:${week}:${t.hoh}` : `double:${week}`);

/** The open deals a twist reopens: a partner's HOH win reopens the deals that HOH is party to; a double eviction reopens every open deal among the living. Ledger order. */
export function reopened(deals: readonly LedgerDeal[], twist: DealTwist, living: ReadonlySet<EntityId>): LedgerDeal[] {
  return deals.filter((d) => d.status === "open" && d.parties.every((p) => living.has(p)) && (twist.kind === "double-eviction" || d.parties.includes(twist.hoh)));
}
