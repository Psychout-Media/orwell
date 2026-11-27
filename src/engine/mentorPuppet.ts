import { PLAYER, type EntityId } from "../domain/ids";
import { BOND, bondKey, type BondRecord } from "./bondRecord";

/**
 * ORW-1079 (Ryne 2026-11-26, ORW-763: "mentor and puppet-master bond kinds"; the coordinator's reading of the approval, 2026-11-27: they must change play, "standing should matter").
 * Two bond kinds the bond record (0175) reserved, read from the HOLDER's side, engine-only (Vault class: never a label or number to the player or admin). Pure, no rng, no I/O.
 *
 *   MENTOR        the holder looks to a SEASONED houseguest who has worked the game with them: the other is clearly older or cast as a game-knower, the holder is warm toward
 *                 them, and they have shared enough strategy scenes. Effect: the protege's eviction vote leans toward the mentor's own pick, and the mentor shields the
 *                 protege a little at nominations and votes.
 *   PUPPET-MASTER the other STEERS the holder: in most of the last few evictions the holder voted the way the other did after working the game with them that week,
 *                 while the other holds little warmth back (instrumental, not friendship). Effect: a larger lean toward the master's pick. Once the holder holds a
 *                 claim that the other lied to them, the steering is seen for what it was: it breaks for good and leaves a grudge.
 *
 * The player can be a mentor or a puppet-master by their own acts (a houseguest's bond toward the player), never anyone's protege or puppet: the player casts their own votes.
 */
export const STEER = {
  /** A mentor is at least this many years older than the holder (or cast as a game-knower). */
  mentorAgeGap: 10,
  /** Strategy scenes the pair have shared before the holder looks to them. */
  mentorStrategyScenes: 3,
  /** The protege's lean toward the mentor's pick (the bloc's is up to 0.33, ORW-972). */
  mentorLean: 0.15,
  /** The mentor's shield of the protege at nominations and votes (added to the feeling that keeps them). */
  mentorShield: 0.1,
  /** Evictions remembered per pair, and how many of them must show the holder voting with the other after a strategy scene. */
  steerWindow: 3,
  steerNeeded: 2,
  /** The puppet's lean toward the master's pick (larger than a mentor's: the steering IS the bond). */
  puppetLean: 0.3,
  /** A master holds less warmth back than this (the friendship bar): it is use, not friendship. */
  masterWarmthBelow: BOND.friendshipAt,
  /** The grudge the holder carries once they see they were steered. */
  exposedResentment: 0.3,
} as const;

/** Casting types (and the archetype) that read as knowing the game: a seasoned player whatever their age. */
export const GAME_KNOWER_TYPES: ReadonlySet<string> = new Set(["superfan", "old-school-player", "wise-head", "elder-statesperson", "mastermind-in-plain-sight"]);
export const GAME_KNOWER_ARCHETYPES: ReadonlySet<string> = new Set(["mastermind"]);

export interface SteerPerson { age?: number; castingType?: string; archetype?: string }

/** Is `other` seasoned relative to `holder`: clearly older, or cast as someone who knows the game. */
export function isSeasoned(holder: SteerPerson, other: SteerPerson): boolean {
  if (other.castingType !== undefined && GAME_KNOWER_TYPES.has(other.castingType)) return true;
  if (other.archetype !== undefined && GAME_KNOWER_ARCHETYPES.has(other.archetype)) return true;
  return typeof holder.age === "number" && typeof other.age === "number" && other.age - holder.age >= STEER.mentorAgeGap;
}

/** The holder's bond toward `other` reads as MENTOR (holder = the protege). */
export function isMentorBond(holderToOther: BondRecord, seasoned: boolean): boolean {
  return seasoned && holderToOther.warmth >= BOND.friendshipAt && (holderToOther.strategy ?? 0) >= STEER.mentorStrategyScenes;
}

/** The steering record: per directed pair `holder|other`, the last few evictions (true = the holder voted with the other after a strategy scene with them that week). */
export interface SteerState {
  /** The week the votes were last read (one read per eviction week; a second count in the same week is ignored). */
  week?: number;
  marks: Record<string, boolean[]>;
  /** Each pair's strategy-scene count at the last read (a rise means they worked the game together since). */
  seen: Record<string, number>;
  /** Pairs whose steering the holder has seen through (never steered again). */
  exposed: string[];
}

export function emptySteerState(): SteerState { return { marks: {}, seen: {}, exposed: [] }; }

/**
 * Read one eviction's ballots into the steering record. For each pair of NPC voters (the holder never the player), the mark is whether the holder voted the same way as the
 * other AND they had a strategy scene since the last read. Only pairs that have worked the game together are tracked (bounded by the bond record). Returns a NEW state.
 */
export function markEviction(st: SteerState, week: number, voteOf: ReadonlyMap<EntityId, EntityId>, strategyOf: (holder: EntityId, other: EntityId) => number): SteerState {
  if (st.week === week) return st;
  const out: SteerState = { week, marks: { ...st.marks }, seen: { ...st.seen }, exposed: [...st.exposed] };
  const voters = [...voteOf.keys()];
  for (const h of voters) {
    if (h === PLAYER) continue; // the player is never anyone's puppet
    for (const o of voters) {
      if (o === h) continue;
      const k = bondKey(h, o);
      const n = strategyOf(h, o);
      if (n <= 0) continue;
      const worked = n > (out.seen[k] ?? 0);
      out.seen[k] = n;
      const mark = worked && voteOf.get(h) === voteOf.get(o);
      out.marks[k] = [...(out.marks[k] ?? []), mark].slice(-STEER.steerWindow);
    }
  }
  return out;
}

/** The holder's bond toward `other` reads as PUPPET-MASTER (holder = the one steered). */
export function isPuppetBond(st: SteerState | undefined, holder: EntityId, other: EntityId, otherToHolder: BondRecord): boolean {
  if (!st || holder === PLAYER) return false;
  const k = bondKey(holder, other);
  if (st.exposed.includes(k)) return false;
  return (st.marks[k] ?? []).filter(Boolean).length >= STEER.steerNeeded && otherToHolder.warmth < STEER.masterWarmthBelow;
}

/** Who leads this voter's vote, and by how much: a master first (the larger lean), else a mentor. Undefined = nobody. Pure over the supplied reads. */
export function steerLead(voter: EntityId, others: readonly EntityId[], reads: { puppet: (h: EntityId, o: EntityId) => boolean; mentor: (h: EntityId, o: EntityId) => boolean }): { by: EntityId; lean: number; kind: "puppet-master" | "mentor" } | undefined {
  if (voter === PLAYER) return undefined;
  const sorted = [...others].filter((o) => o !== voter).sort();
  const master = sorted.find((o) => reads.puppet(voter, o));
  if (master !== undefined) return { by: master, lean: STEER.puppetLean, kind: "puppet-master" };
  const mentor = sorted.find((o) => reads.mentor(voter, o));
  if (mentor !== undefined) return { by: mentor, lean: STEER.mentorLean, kind: "mentor" };
  return undefined;
}
