import type { EntityId } from "../domain/ids";
import type { HouseGraph } from "./houseGraph";

/**
 * Feature 0179 - Theme 3 slice 9 (ORW-552): NETWORK SHAPE IN THE SPREAD. Built on the house graph (0177) and Theme 2's co-presence spread. PURE: no rng, no I/O.
 *
 * The co-presence spread (`copresenceSpread.ts`) decides, scene by scene, whether a holder passes a fact to a listener; its MOTIVE is affinity to the listener,
 * the threat of the fact's subject and the fact's confidence. This adds the house's shape to that motive:
 *  - a BROKER (ties into two cliques) carries news ACROSS: telling someone outside the clique of the person the news is about is worth more to them
 *    (information and leverage are the broker's trade);
 *  - a WEAK TIE carries across too: between two houseguests in different cliques who are casually tied (not strangers, not close), news travels a little
 *    more readily than inside a close clique, where everyone already knows;
 *  - a LONER hears late: holders bother less with someone tied to almost no one.
 * The roles come from the house graph, derived once a day from the bonds. Engine-only: roles and motives never reach the player.
 */
export const NETWORK = {
  /** A broker telling someone outside the clique of the fact's subject. */
  brokerBridge: 0.25,
  /** Anyone telling a listener in a different clique, when their tie is casual. */
  weakTieAcross: 0.1,
  /** A casual tie: at least this close... */
  weakTieMin: 0.1,
  /** ...and below this (the house graph's tie threshold is where "close" starts). */
  weakTieMax: 0.5,
  /** Telling a loner. */
  lonerDamp: -0.2,
} as const;

/** A houseguest's place in the house's shape, as the spread reads it. */
export interface NetworkRoles {
  /** Every clique the houseguest is in (indexes into the graph's cliques); empty for none. */
  cliquesOf(id: EntityId): readonly number[];
  isBroker(id: EntityId): boolean;
  isLoner(id: EntityId): boolean;
  /** The undirected closeness the graph was derived from, 0..1. */
  tie(a: EntityId, b: EntityId): number;
}

export function rolesFromGraph(graph: HouseGraph, tie: (a: EntityId, b: EntityId) => number): NetworkRoles {
  const cliques = new Map<EntityId, number[]>();
  graph.cliques.forEach((members, i) => { for (const m of members) (cliques.get(m) ?? cliques.set(m, []).get(m)!).push(i); });
  const brokers = new Set(graph.brokers), loners = new Set(graph.loners);
  return { cliquesOf: (id) => cliques.get(id) ?? [], isBroker: (id) => brokers.has(id), isLoner: (id) => loners.has(id), tie };
}

const shares = (a: readonly number[], b: readonly number[]): boolean => a.some((x) => b.includes(x));

/**
 * The network's add to the spread motive for `holder` telling `listener` a fact about `subject` (if any). Signed; the caller clamps the total motive 0..1.
 * 0 when nobody involved has a place in the shape (no cliques, no roles), so a house with no structure spreads exactly as before.
 */
export function networkMotive(holder: EntityId, listener: EntityId, subject: EntityId | undefined, n: NetworkRoles): number {
  let m = 0;
  const lc = n.cliquesOf(listener);
  if (n.isBroker(holder) && subject !== undefined) {
    const sc = n.cliquesOf(subject);
    if (sc.length > 0 && !shares(sc, lc)) m += NETWORK.brokerBridge;
  }
  const hc = n.cliquesOf(holder);
  const t = n.tie(holder, listener);
  if (hc.length > 0 && lc.length > 0 && !shares(hc, lc) && t >= NETWORK.weakTieMin && t < NETWORK.weakTieMax) m += NETWORK.weakTieAcross;
  if (n.isLoner(listener)) m += NETWORK.lonerDamp;
  return m;
}
