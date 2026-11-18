import type { EntityId } from "../domain/ids";
import type { EdgeSignals } from "./relationshipConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * Feature 0202 / ORW-645 (Ryne approved 2026-11-17, Fable 4.2) - LEVERAGE IN TWO REGISTERS. A held secret about someone is pressure that can be used blunt (an explicit
 * demand) or sneaky (quiet pressure: a hint that you know, a favour that quietly becomes a debt, a well-timed word). It is one tool among many: most of the time a holder
 * simply keeps what they hold. Builds on 0093/0099 (`leverage.ts`: the strength, the refusal floor and the squeeze backlash are reused verbatim, not re-invented).
 * PURE: no I/O, no rng of its own (the caller rolls on a side stream keyed on holder, week and day, never the shared rng). Engine-only: the secret's content never enters
 * a play record or a view; only who leans on whom and in what manner reaches the narrator.
 */
export type LeverageManner = "blunt" | "sneaky";

export const LEVERAGE_PLAY = {
  /** The chance a holder with real desire acts on it on a given day. Most days, and most holders, keep what they hold. */
  playChance: 0.18,
  /** Desire (0..1) below this: nothing is played however the roll falls. */
  desireFloor: 0.4,
  /** Weights of the desire to lean on a target: the holder's stakes, their wariness of the target, how sharp the secret is, how little they like the target. */
  stakesWeight: 0.35,
  threatWeight: 0.3,
  severityWeight: 0.2,
  coldnessWeight: 0.15,
  /** A holder on the block weighs the stakes fully; a holder safe this week weighs this share of it. */
  safeStakes: 0.25,
  /** Register: starts even; a bold holder leans blunt, a warm bond or a shrewd target leans sneaky. */
  mannerBase: 0.5,
  boldnessWeight: 0.4,
  warmthWeight: 0.35,
  shrewdnessWeight: 0.3,
  /** A sneaky play presses less than a blunt one (quiet pressure is quieter). */
  sneakyStrengthMult: 0.65,
  /** The chance a sneaky play is noticed: a base plus how suspicious the target is (credulity below the middle). */
  noticeBase: 0.2,
  noticeSuspicionWeight: 0.6,
  /** A blunt demand that is refused costs more than the 0093 squeeze (it was said out loud and turned down). */
  bluntRefusalMult: 1.6,
  /** A noticed sneaky play: the target's read of the holder sours (the 0093 squeeze shape at this share). */
  noticedMult: 1.1,
  /** A sneaky play that works: the target quietly owes the holder (trust, alignment toward them). */
  debtFold: { trust: +0.03, alignment: +0.04 } as Partial<EdgeSignals>,
  /** The debt grows with how hard the quiet pressure landed: scale = base + strength x sneakyStrengthMult. */
  debtBase: 0.5,
  /** Days before the same holder presses the same target on the same secret again. */
  cooldownDays: 4,
  /** Days a play on the player stays open for the player to answer; after that it lapses unanswered. */
  answerDays: 2,
  /** A holder whose demand the player ignored: their read of the player sours (the 0093 squeeze shape at this share). */
  ignoredMult: 1.0,
  /** Hard cap on plays begun per day across the house. */
  maxPlaysPerDay: 2,
} as const;

export interface LeveragePlay {
  id: string;
  week: number;
  day: number;
  holder: EntityId;
  target: EntityId;
  /** The held fact's id (engine-only; never projected). */
  factKey: string;
  manner: LeverageManner;
  /** open = waiting for the player to answer; the rest are closed outcomes. */
  status: "open" | "complied" | "refused" | "noticed" | "worked" | "answered" | "lapsed";
}

export interface PlaySignals {
  /** The secret's public severity (its kind, never its text). */
  severity: number;
  /** The holder's directed read of the target. */
  holderThreatOfTarget: number;
  holderAffinityForTarget: number;
  holderTrustInTarget: number;
  /** Whether the holder is on the block this week. */
  holderOnBlock: boolean;
  /** The holder's steadiness (soul emotionalState, 0..1): steadier is bolder. */
  holderNerve: number;
  /** The target's credulity (0..1, 0.5 takes a tale at its word); undefined when the target is the player. */
  targetCredulity: number | undefined;
}

/** How much the holder wants to lean on the target (0..1). Nothing here is a number the player sees. */
export function pressureDesire(s: PlaySignals): number {
  const stakes = s.holderOnBlock ? 1 : LEVERAGE_PLAY.safeStakes;
  const coldness = clamp01(0.5 - (s.holderAffinityForTarget + s.holderTrustInTarget) / 2 + 0.5);
  return clamp01(
    LEVERAGE_PLAY.stakesWeight * stakes + LEVERAGE_PLAY.threatWeight * clamp01(s.holderThreatOfTarget) +
    LEVERAGE_PLAY.severityWeight * clamp01(s.severity) + LEVERAGE_PLAY.coldnessWeight * coldness,
  );
}

/** Whether the holder plays at all this day (one roll in [0,1)). */
export function willPlay(desire: number, roll: number): boolean {
  return desire >= LEVERAGE_PLAY.desireFloor && roll < LEVERAGE_PLAY.playChance;
}

/** Which register (one roll in [0,1)): a bold, cold holder goes blunt; a warm bond or a shrewd target pushes toward sneaky. */
export function chooseManner(s: PlaySignals, roll: number): LeverageManner {
  const warmth = clamp01((s.holderAffinityForTarget + s.holderTrustInTarget) / 2);
  const shrewd = s.targetCredulity === undefined ? 0.5 : 1 - clamp01(s.targetCredulity);
  const bluntP = clamp01(
    LEVERAGE_PLAY.mannerBase + LEVERAGE_PLAY.boldnessWeight * (s.holderNerve - 0.5) - LEVERAGE_PLAY.warmthWeight * (warmth - 0.5) -
    LEVERAGE_PLAY.shrewdnessWeight * (shrewd - 0.5),
  );
  return roll < bluntP ? "blunt" : "sneaky";
}

/** Whether a sneaky play is noticed by an NPC target (one roll in [0,1)): the more suspicious the target, the likelier. */
export function sneakyNoticed(targetCredulity: number, roll: number): boolean {
  const p = clamp01(LEVERAGE_PLAY.noticeBase + LEVERAGE_PLAY.noticeSuspicionWeight * (0.5 - clamp01(targetCredulity)));
  return roll < p;
}

/** A third-person fact for the narrator: who leans on the player and in what manner. No secret content, no number. */
export interface LeansOnYou { manner: LeverageManner }
