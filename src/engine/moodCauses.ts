/**
 * 0194 / ORW-626 - MOODS WITH MORE CAUSES (Ryne approved 2026-11-17). Today a mood has a cause only when a goal settled (innerLife). This adds the other things that
 * truly move a houseguest: being lied to, a close friend leaving, a bad night's sleep, a betrayal learned, a win, a loss.
 *
 * The engine decides WHAT the cause is (the substance, from facts it already holds) and the narrator voices it in the houseguest's own words (ORW-583). A cause is
 * VAULT-CLASS: it lives in the hidden layer and reaches the player only when the houseguest CHOOSES to say it (trust + candor, a cause that points at a grudge needs more
 * of both), under their own name. No number and no hidden cause ever crosses; the mood WORD stays visible to all through the tells.
 *
 * Pure and deterministic: no rng, no I/O. The `source` keys are engine-only enum keys (never player text); each line is a keyed lookup, never a random pick.
 */
import type { EntityId } from "../domain/ids";

export type MoodCauseSource = "lied-to" | "betrayed" | "friend-evicted" | "bad-sleep" | "won" | "lost";

/** One recorded cause (append-only). `line` is an engine FACT in the third person (the narrator voices it in the houseguest's own words), `{subject}` for `about`. Vault-class until the houseguest chooses to say it. */
export interface MoodCauseEntry {
  holder: EntityId;
  source: MoodCauseSource;
  line: string;
  about?: EntityId;
  week: number;
  /** In-game day (when known), for the order of causes within a week. */
  day?: number;
}

export const MOOD_CAUSES = {
  /** How strongly each source weighs when a houseguest has several causes this week: the heaviest is the one they would give. A goal cause (innerLife) weighs `goalWeight`. */
  weight: { "lied-to": 0.9, betrayed: 0.9, "friend-evicted": 0.8, won: 0.45, lost: 0.45, "bad-sleep": 0.3 } satisfies Record<MoodCauseSource, number>,
  goalWeight: 0.6,
  /** A night counts as a bad night's sleep from this hidden rest deficit (0..1 = hours past midnight / 8; 0.25 is two in the morning). */
  badSleepDeficit: 0.25,
  /** A close friend is someone whose bond (the mean of trust and affinity toward the evictee) is at least this. */
  friendBond: 0.55,
  /** A lie costs the liar's word, and the mood: the existing "betrayed" step at this share. */
  liedToMoodScale: 0.5,
  /** The listener closeness + candor a cause needs before the houseguest would say it. A cause that points at a grudge needs more. */
  /** A bad night's sleep moves the mood word through the existing "scheme" step (low-grade agitation, the nearest to short-tempered) at this share. Bounded, keyed, no rng. */
  badSleepMoodScale: 0.5,
  /** A cause stays speakable for this many in-game days after the day it landed (the days after it fall in weight), then it is no longer given. The log itself is never trimmed. */
  carryDays: 3,
  shareBar: 0.9,
  grudgeShareBar: 1.25,
} as const;

// Ryne 11-17/11-18 ("avoid designing shortlists"): these are FACTS for the narrator to voice in the houseguest's own words (the lever's instruction
// says so), never a line to recite: third person, no tone, no phrasing to copy. The words the player hears are authored live from the houseguest's voice.
const LINES: Readonly<Record<MoodCauseSource, string>> = {
  "lied-to": "they found out {subject} had lied to them",
  betrayed: "{subject} broke a deal with them",
  "friend-evicted": "{subject}, someone they counted on, has just left the house",
  "bad-sleep": "they slept badly last night",
  won: "they won this week's competition",
  lost: "they lost this week's competition",
};

/** The engine words for a cause source (a keyed lookup). */
export function causeLine(source: MoodCauseSource): string {
  return LINES[source];
}

/** The cause a houseguest has to give this week, if any: the heaviest by `weight`, the latest winning a tie. */
export function strongestCause(log: readonly MoodCauseEntry[] | undefined, holder: EntityId, week: number): MoodCauseEntry | undefined {
  let best: MoodCauseEntry | undefined;
  for (const c of log ?? []) {
    if (c.holder !== holder || c.week !== week) continue;
    if (!best || MOOD_CAUSES.weight[c.source] >= MOOD_CAUSES.weight[best.source]) best = c;
  }
  return best;
}

/** Whether the houseguest would SAY this cause to the listener. A cause that points at a grudge (a lie, a betrayal) needs more closeness and candor than a plain one. */
export function mayShareEventCause(source: MoodCauseSource, listenerAffinity: number, candor: number): boolean {
  const grudge = source === "lied-to" || source === "betrayed";
  return listenerAffinity + candor >= (grudge ? MOOD_CAUSES.grudgeShareBar : MOOD_CAUSES.shareBar);
}

/** Whether a night's hidden rest deficit is a bad night's sleep. */
export function isBadNight(deficit: number): boolean {
  return deficit >= MOOD_CAUSES.badSleepDeficit;
}

/** Whether a bond (trust and affinity toward someone) makes them a close friend. */
export function isCloseFriend(trust: number, affinity: number): boolean {
  return (trust + affinity) / 2 >= MOOD_CAUSES.friendBond;
}

/** How many in-game days old a cause is (0 = today). With no day on either side, the same week is today and any other week is out of reach. */
export function causeAge(c: MoodCauseEntry, week: number, day: number | undefined): number {
  if (c.day !== undefined && day !== undefined) return day - c.day;
  return c.week === week ? 0 : Number.POSITIVE_INFINITY;
}

/** The share of its weight a cause of this age keeps: full today, falling by an equal step each day, none past `carryDays` (or from the future). Pure, keyed on in-game days. */
export function carryFactor(age: number): number {
  if (!(age >= 0) || age > MOOD_CAUSES.carryDays) return 0;
  return 1 - age / (MOOD_CAUSES.carryDays + 1);
}

/** 0194 follow-up: the cause a houseguest has to give NOW, with its aged weight: the heaviest of `weight x carryFactor(age)` (the latest wins a tie). Causes carry across the week roll while they last. */
export function strongestLiveCause(log: readonly MoodCauseEntry[] | undefined, holder: EntityId, week: number, day: number | undefined): { entry: MoodCauseEntry; weight: number } | undefined {
  let best: { entry: MoodCauseEntry; weight: number } | undefined;
  for (const c of log ?? []) {
    if (c.holder !== holder) continue;
    const w = MOOD_CAUSES.weight[c.source] * carryFactor(causeAge(c, week, day));
    if (w <= 0) continue;
    if (!best || w >= best.weight) best = { entry: c, weight: w };
  }
  return best;
}
