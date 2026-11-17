import type { EntityId } from "../domain/ids";
import type { BeliefClaim } from "./beliefStore";
import { underTest } from "./beliefConviction";

/**
 * Feature 0188 / ORW-619 (Ryne approved 2026-11-17, Fable pitch #5) - THE TRAP. A suspicious houseguest who doubts someone's discretion tells them, and only them,
 * a made-up secret (a canary), then watches whether it comes back from anyone else. If it does, they know who leaked; if it never does, the suspect passed.
 * Houseguests can trap the player too; the player can trap a houseguest by talking (ORW-612's player claims). PURE: no I/O, no rng of its own (the caller rolls on
 * its own side stream). Extends conviction's "tests what they doubt" (0160): a doubt about a person's discretion is tested by a trap, not only by asking around.
 * Engine-only (Vault class): no view shows a trap; the narrator voices the canary as an ordinary confidence, with no tell.
 */
export const TRAP = {
  /** Only a suspicious houseguest sets traps: credulity (0..1, 0.5 = takes a tale at its word) below this. */
  suspiciousBelow: 0.45,
  /** The chance a suspicious houseguest with a doubt about someone's discretion sets a trap on a given day (their own side stream). */
  setChance: 0.3,
  /** Days a trap is watched; if the canary has not come back by then, the suspect passed. */
  watchDays: 3,
  /** A sprung trap: the setter's read of the leaker (trust, affinity). */
  springTrust: -0.08,
  springAffinity: -0.04,
  /** ...and how sure they then are that the leaker talks (a deduction from their own evidence). */
  springConfidence: 0.85,
  /** A held trap: the setter's trust in the suspect rises this much (they kept the secret). */
  heldTrust: 0.03,
} as const;

/** The doubts about someone's DISCRETION a trap tests: a rumor they talk or lie, or a lie of theirs the holder is not yet sure of. */
const DISCRETION_RUMORS: ReadonlySet<string> = new Set(["talking-about", "lying"]);
export function doubtsDiscretionOf(held: readonly BeliefClaim[], holder: EntityId): EntityId[] {
  const out = new Set<EntityId>();
  for (const b of held) {
    if (!underTest(b) || b.subject === holder) continue;
    if (b.kind === "lied-to-me" || (b.kind === "heard-rumor" && DISCRETION_RUMORS.has(b.nature ?? ""))) out.add(b.subject);
  }
  return [...out].sort();
}

export interface Trap {
  id: string;
  setter: EntityId;
  suspect: EntityId;
  /** The canary: "<subject> is going after <setter>" - made up (the engine checked it is not true when it was set). */
  subject: EntityId;
  factId: string;
  week: number;
  day: number;
  /** open = being watched; pending = waiting to be said to the player (the next time the setter is with them); sprung = it came back; held = it never did; lapsed = a pending one never got said. */
  status: "pending" | "open" | "sprung" | "held" | "lapsed";
  /** Who it came back through (sprung only). */
  via?: EntityId;
}

/** The canary's subject: the houseguest the setter reads as most threatening, among those the canary would be FALSE about (`isTrue` = the engine's check), never the suspect or the setter. */
export function canarySubject(setter: EntityId, suspect: EntityId, living: readonly EntityId[], threatOf: (other: EntityId) => number, isTrue: (subject: EntityId) => boolean): EntityId | undefined {
  return living.filter((x) => x !== setter && x !== suspect)
    .sort((a, b) => threatOf(b) - threatOf(a) || (a < b ? -1 : a > b ? 1 : 0))
    .find((x) => !isTrue(x));
}

/** Did the canary come back to the setter from someone OTHER than the suspect? Their held beliefs (a claim with the canary's content, from another source). */
export function canaryReturned(trap: Pick<Trap, "setter" | "suspect" | "subject" | "week">, setterHeld: readonly BeliefClaim[]): EntityId | undefined {
  const hit = setterHeld.find((b) => b.value && b.week >= trap.week && b.subject === trap.subject && b.source !== undefined && b.source !== trap.suspect && b.source !== trap.setter
    && ((b.kind === "heard-rumor" && b.nature === "going-after" && b.object === trap.setter) || (b.kind === "targets-me" && (b.object === undefined || b.object === trap.setter))));
  return hit?.source;
}

/**
 * Feature 0188 part 2 / ORW-627 (Ryne approved 2026-11-17, Fable Theme 2 idea #11) - OVERHEARD ON PURPOSE OR BY ACCIDENT. A story planted in a room (a house-life
 * plant) is a co-present scene: anyone else in that room, awake, may overhear it - each on their own keyed roll. A houseguest who overhears it holds that the planter is
 * talking about the target behind their back (`heard-rumor`, nature `talking-about`, origin `overheard`); the player who overhears it hears the words, as a scene they
 * were in. Never whether it is true. Pure: the caller supplies the rolls.
 */
export const OVERHEAR_PLANT = {
  /** The chance one awake bystander in the room catches a plant. */
  chance: 0.35,
  /** How sure an overhearing houseguest is that the planter is talking behind the target's back: they heard it with their own ears, so it is a fact to them (at or
   *  above 0160's `asFact`), not a doubt to go asking around about (which would add the gossip scenes a doubt drives). */
  confidence: 0.75,
} as const;

/** Who in the room overhears the plant: awake bystanders (never the two speaking) whose own roll lands. Sorted, deterministic in the rolls. */
export function overhearers(room: readonly EntityId[], speaker: EntityId, listener: EntityId, awake: (id: EntityId) => boolean, roll: (id: EntityId) => number): EntityId[] {
  return room.filter((id) => id !== speaker && id !== listener && awake(id) && roll(id) < OVERHEAR_PLANT.chance).sort();
}

/** The words of a claim as an overheard line (engine kinds to plain words; names filled by the caller). */
export function claimWords(kind: string, subject: string, object: string | undefined): string {
  switch (kind) {
    case "targets-you": return `${subject} is coming after them`;
    case "going-after": return object ? `${subject} is going after ${object}` : `${subject} is going after someone`;
    case "final-two-with": return object ? `${subject} has a final two with ${object}` : `${subject} has a final two`;
    case "talking-about": return object ? `${subject} has been talking about ${object}` : `${subject} has been talking behind backs`;
    case "lying-about": return object ? `${subject} has been lying to ${object}` : `${subject} has been lying`;
    case "voted-against": case "voted-to-evict-you": return object ? `${subject} voted to evict ${object}` : `${subject} voted against them`;
    case "voted-to-keep": return object ? `${subject} voted to keep ${object}` : `${subject} voted to keep them`;
    default: return `something about ${subject}`;
  }
}
