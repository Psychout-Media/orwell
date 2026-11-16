import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { ClaimInput, SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0154 / ORW-330 (theme 2, slice 5b) - LYING ABOUT YOUR VOTE. When an eviction is over the vote is public and the ballots stay secret.
 * Each NPC voter may then tell ONE other NPC how they voted: the ENGINE decides whether to say it, whether it is TRUE (from the speaker's real
 * ballot, passed in by the adapter and never kept here) and what to say when it is not. Cunning lies more, candor less, and NEED lies most: having
 * voted against someone the listener likes. A speaker who voted with the house (the evictee) to a listener who did not like the evictee has no need.
 *
 * The claim is "I voted to keep X" (`voted-to-keep`: subject = the speaker, object = the nominee they say they kept). Truthful, X is the nominee
 * they did not vote against; a lie names the nominee they DID vote to evict, told to someone who likes that nominee.
 *
 * Pure rules: no I/O, no rng of its own (the caller passes rolls from its own `${seed}:vote-talk` stream). The ballot never leaves the caller:
 * the result carries the CLAIM, whether it is true, and nothing about any other voter. ENGINE-ONLY like every claim.
 */

export const VOTE_TALK = {
  /** Chance a given NPC voter tells anyone how they voted, before need. */
  tellBase: 0.4,
  /** Extra chance to tell when the speaker voted against someone the listener likes (they feel they must explain). */
  tellNeed: 0.2,
  /** Base chance a telling is a lie. */
  lieBase: 0.08,
  /** Added chance of a lie per unit of archetype cunning (0..1). */
  lieCunning: 0.3,
  /** Added chance of a lie per unit of need (0..1). */
  lieNeed: 0.45,
  /** Taken off the lie chance per unit of candor (0..1). */
  lieCandor: 0.15,
  /** The ceiling no combination of the above passes: most tellings stay honest. */
  lieMax: 0.8,
  /** How many tellings one speaker makes per eviction. */
  maxPerSpeaker: 1,
  /** The listener is drawn from this many of the speaker's closest NPCs (by the listener's liking of the speaker). */
  listenerPool: 3,
} as const;

/** The claim kind a vote telling uses (one place to change it). */
export const CLAIM_KIND: SpokenClaimKind = "voted-to-keep";

/** Archetype cunning (0..1), local to this module (the table in houseMeeting.ts is not on this base). Unknown archetypes read 0.4. */
const CUNNING_BY_ARCHETYPE: Readonly<Record<string, number>> = {
  mastermind: 0.9, villain: 0.8, analyst: 0.6, wildcard: 0.55, "social-butterfly": 0.5, flirt: 0.5, floater: 0.4,
  "comp-beast": 0.35, underdog: 0.3, peacemaker: 0.25, loyalist: 0.2, hothead: 0.15,
};
export function voteTalkCunning(archetype: string | undefined): number { return (archetype !== undefined ? CUNNING_BY_ARCHETYPE[archetype] : undefined) ?? 0.4; }

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** The three rolls (each in [0,1)) the caller draws from its own seeded side stream for one speaker. */
export interface VoteTalkRolls { tell: number; pick: number; lie: number }

export interface VoteTalkInput {
  speaker: EntityId;
  /** The houseguests who could be told (living NPCs other than the speaker); the planner never picks the player. */
  candidates: readonly EntityId[];
  /** Who the speaker REALLY voted to evict (engine truth, from the ballot). */
  real: EntityId;
  /** The nominees at the vote (the evictee and the one who stayed). */
  nominees: readonly EntityId[];
  cunning: number;
  candor: number;
  /** How much `listener` likes `of`, 0..1 (the listener's own hidden read). */
  likes: (listener: EntityId, of: EntityId) => number;
  rolls: VoteTalkRolls;
}

export interface VoteTalk {
  claim: Pick<ClaimInput, "kind" | "speaker" | "listener" | "subject" | "object" | "isTrue" | "intent">;
  truthful: boolean;
}

/** How much the listener has riding on the speaker's real vote: they like the nominee the speaker voted against (0 = nothing, 1 = a great deal). */
export function voteNeed(listener: EntityId, real: EntityId, likes: VoteTalkInput["likes"]): number {
  return clamp01((likes(listener, real) - 0.5) * 2);
}

/** The chance a telling to this listener is a lie. */
export function lieChance(need: number, cunning: number, candor: number): number {
  return Math.min(VOTE_TALK.lieMax, Math.max(0, VOTE_TALK.lieBase + VOTE_TALK.lieCunning * clamp01(cunning) + VOTE_TALK.lieNeed * clamp01(need) - VOTE_TALK.lieCandor * clamp01(candor)));
}

/**
 * Whether this speaker tells anyone how they voted, to whom, and whether it is true. Undefined = they say nothing (the usual case).
 * At most one telling per speaker per eviction (`maxPerSpeaker`), enforced by the caller calling this once per speaker.
 */
export function decideVoteTalk(i: VoteTalkInput): VoteTalk | undefined {
  const others = i.candidates.filter((c) => c !== i.speaker && c !== PLAYER);
  if (others.length === 0 || !i.nominees.includes(i.real)) return undefined;
  const pool = [...others].sort((a, b) => i.likes(b, i.speaker) - i.likes(a, i.speaker) || a.localeCompare(b)).slice(0, VOTE_TALK.listenerPool);
  const listener = pool[Math.min(pool.length - 1, Math.floor(i.rolls.pick * pool.length))]!;
  const need = voteNeed(listener, i.real, i.likes);
  if (i.rolls.tell >= VOTE_TALK.tellBase + VOTE_TALK.tellNeed * need) return undefined;
  const kept = i.nominees.find((n) => n !== i.real && n !== i.speaker);
  const lie = i.rolls.lie < lieChance(need, i.cunning, i.candor);
  const object = lie ? i.real : kept;
  if (object === undefined || object === i.speaker) return undefined;
  return {
    claim: { kind: CLAIM_KIND, speaker: i.speaker, listener, subject: i.speaker, object, isTrue: !lie, intent: lie ? "mislead" : "inform" },
    truthful: !lie,
  };
}
