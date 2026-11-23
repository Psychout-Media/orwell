import type { EntityId } from "../domain/ids";
import type { BeliefClaim, BeliefStore } from "./beliefStore";
import { recordClaim } from "./beliefStore";

/**
 * ORW-767 (0207, behind `ORWELL_COUPLE_TOLD`, default ON) - A SHOWMANCE REACHES THE PLAYER BY BEING TOLD.
 *
 * Ryne's rule: what the player knows about someone is only what they saw or were told. The narrator's showmance list was gated on a scene the player was in or watched; a pair a houseguest TELLS the player about
 * had no route. This is that route, in the existing belief layer: a `couple` belief (`beliefStore.ts`'s one new closed-set kind: subject and object are the pair, ordered by id) is written by the scene the
 * holder saw (first-hand) and by a houseguest passing it on in a speech scene (told, a little less sure, and sometimes the pair is MISHEARD: a retelling can name the wrong partner). A houseguest in a room with
 * the player may then tell it, through the same trust / crowd gates a confidence takes (`tellChance`); the player then holds it as a knowledge fact with its teller and a confidence, and the pair's id lineage
 * `couple:<a>|<b>`. The player knows a told pair as a BELIEF: it is never upgraded to the truth (the narrator's showmance list still needs the real pair at the stage the house knows AND the player having
 * seen or been told it), and a pair that was misheard stays what it is, a houseguest's belief.
 *
 * Engine-only data here; no I/O, no shared stream (the caller draws every number from its own keyed side stream, `${seed}:couple-told:...`). Nothing here knows whether a pair is true.
 */
export const COUPLE_TOLD = {
  /** A holder who SAW a romance scene (in the room, or noticed from it) holds the pair this sure. */
  seenConfidence: 0.8,
  /** A pair passed on is held at the teller's confidence times this (second-hand is a little less sure). */
  retoldFactor: 0.8,
  /** The chance a houseguest in a speech scene passes on ONE couple belief they hold to the other person. */
  talkChance: 0.3,
  /** The chance a retelling names the wrong partner (a misheard pair). */
  mishearChance: 0.1,
  /** Below this a houseguest does not pass a pair on or tell it to the player (too unsure to say). */
  passFloor: 0.3,
  /** The most couple beliefs one houseguest holds: the belief store is bounded per holder (`BELIEF_CAP_PER_HOLDER`), and a retelling that names a new pair each time must not crowd out the beliefs decisions read. */
  perHolderCap: 5,
} as const;

/** The pair, ordered by id (the same unordered key the showmance read uses). */
export const couplePair = (a: EntityId, b: EntityId): [EntityId, EntityId] => (a < b ? [a, b] : [b, a]);
/** The lineage id the player's knowledge fact carries for a told pair. */
export const coupleFactId = (a: EntityId, b: EntityId): string => `couple:${couplePair(a, b).join("|")}`;
/** One belief per holder per pair (a stronger re-record is the only update; `recordClaim` keeps the higher confidence). */
export const coupleBeliefId = (holder: EntityId, a: EntityId, b: EntityId): string => `${holder}|couple|${couplePair(a, b).join("|")}`;

/** Write (or strengthen) `holder`'s belief that `a` and `b` are a couple. Returns true when the store changed. */
export function writeCouple(store: BeliefStore, holder: EntityId, a: EntityId, b: EntityId, o: { origin: "witnessed" | "told"; source?: EntityId; confidence: number; week: number }): boolean {
  if (holder === a || holder === b || a === b) return false;
  const [x, y] = couplePair(a, b);
  const held = (store[holder] ?? []).filter((c) => c.kind === "couple");
  if (held.length >= COUPLE_TOLD.perHolderCap && !held.some((c) => c.id === coupleBeliefId(holder, x, y))) return false;
  return recordClaim(store, { id: coupleBeliefId(holder, x, y), holder, kind: "couple", subject: x, object: y, value: true, origin: o.origin, ...(o.source !== undefined ? { source: o.source } : {}), confidence: o.confidence, week: o.week });
}

/** The couple beliefs a holder could pass on: held, not refuted, not about the holder, surest first then by id. */
export function passableCouples(beliefs: readonly BeliefClaim[] | undefined, holder: EntityId): BeliefClaim[] {
  return (beliefs ?? [])
    .filter((b) => b.kind === "couple" && b.value && !b.refuted && b.object !== undefined && b.subject !== holder && b.object !== holder && b.confidence >= COUPLE_TOLD.passFloor)
    .sort((p, q) => q.confidence - p.confidence || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** What a retelling names: the pair as heard, or - on the mishear roll - the first person with a different partner picked from `pool` by `pick`. Deterministic in its inputs. */
export function retold(pair: readonly [EntityId, EntityId], misheard: number, pick: number, pool: readonly EntityId[]): [EntityId, EntityId] {
  if (!(misheard < COUPLE_TOLD.mishearChance)) return [pair[0], pair[1]];
  const others = pool.filter((id) => id !== pair[0] && id !== pair[1]);
  if (others.length === 0) return [pair[0], pair[1]];
  return couplePair(pair[0], others[Math.min(others.length - 1, Math.floor(pick * others.length))]!);
}

/** The words a told pair is held in (engine fact; the narrator voices it in the teller's own words). */
export const coupleContent = (aName: string, bName: string): string => `${aName} and ${bName} are seeing each other`;
