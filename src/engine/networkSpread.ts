import type { EntityId } from "../domain/ids";
import type { HouseGraph } from "./houseGraph";
import { HOUSE_GRAPH } from "./houseGraphConstants";

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
 *
 * Fable's pre-merge review (2026-11-17):
 *  - a house with no structure spreads exactly as before: an untied house reads every houseguest as a graph "loner", so the loner damp applies only once the
 *    house HAS cliques (being outside every group then means something);
 *  - the graph's maximal cliques overlap heavily, so "a different clique" is read on GROUPS: cliques that share at least half of the smaller one are merged;
 *    a broker is someone tied into two groups, and the broker bonus needs the broker tied into BOTH the subject's group and the listener's;
 *  - the shape reaches movement too (`seekTargets`): a broker with news is drawn toward the other group, as the spread motive is.
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
  /** Every group (merged overlapping cliques) the houseguest is in; empty for none. */
  cliquesOf(id: EntityId): readonly number[];
  /** Is the houseguest a member of group `g`, or tied into it (at least `HOUSE_GRAPH.brokerMinLinks` close ties to its members)? */
  tiedInto(id: EntityId, g: number): boolean;
  isBroker(id: EntityId): boolean;
  isLoner(id: EntityId): boolean;
  /** The undirected closeness the graph was derived from, 0..1. */
  tie(a: EntityId, b: EntityId): number;
}

/** Merge cliques that share at least half of the smaller one, until none do. Deterministic: groups sorted by their first member. */
export function mergeCliques(cliques: readonly (readonly EntityId[])[]): EntityId[][] {
  let groups = cliques.map((c) => [...new Set(c)].sort());
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!, b = groups[j]!, bs = new Set(b);
      const shared = a.filter((x) => bs.has(x)).length;
      if (shared * 2 >= Math.min(a.length, b.length)) {
        groups[i] = [...new Set([...a, ...b])].sort();
        groups.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  groups = groups.sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
  return groups;
}

export function rolesFromGraph(graph: HouseGraph, tie: (a: EntityId, b: EntityId) => number): NetworkRoles {
  const groups = mergeCliques(graph.cliques);
  const memberOf = new Map<EntityId, number[]>();
  groups.forEach((members, i) => { for (const m of members) (memberOf.get(m) ?? memberOf.set(m, []).get(m)!).push(i); });
  const tiedInto = (id: EntityId, g: number): boolean => {
    const members = groups[g];
    if (!members) return false;
    if (members.includes(id)) return true;
    return members.filter((m) => tie(id, m) >= HOUSE_GRAPH.tieThreshold).length >= HOUSE_GRAPH.brokerMinLinks;
  };
  const brokers = new Map<EntityId, boolean>();
  const isBroker = (id: EntityId): boolean => {
    let b = brokers.get(id);
    if (b === undefined) { b = groups.filter((_, g) => tiedInto(id, g)).length >= 2; brokers.set(id, b); }
    return b;
  };
  const structured = groups.length > 0; // an untied house has no loners worth the name: everyone is outside every group
  const loners = new Set(structured ? graph.loners : []);
  return { cliquesOf: (id) => memberOf.get(id) ?? [], tiedInto, isBroker, isLoner: (id) => loners.has(id), tie };
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
    // across: the listener is in a group the subject is not in, and the broker is tied into both sides (the subject's group and the listener's)
    if (sc.length > 0 && lc.length > 0 && !shares(sc, lc) && sc.some((g) => n.tiedInto(holder, g)) && lc.some((g) => n.tiedInto(holder, g))) m += NETWORK.brokerBridge;
  }
  const hc = n.cliquesOf(holder);
  const t = n.tie(holder, listener);
  if (hc.length > 0 && lc.length > 0 && !shares(hc, lc) && t >= NETWORK.weakTieMin && t < NETWORK.weakTieMax) m += NETWORK.weakTieAcross;
  if (n.isLoner(listener)) m += NETWORK.lonerDamp;
  return m;
}
