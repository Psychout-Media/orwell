/**
 * ORW-576 - ONE mood bucketing. The mood WORD the narrator is handed (`moodWord` in voice.ts) and the observable TELLS the room sees (`narratedTellsOf` in tells.ts) used to read different variables, so a
 * houseguest could be voiced "even" while a strong "snapping" tell fired. This leaf module holds the single level (the acute state blended with the season's marinated baseline) and the single closed band
 * (`low` / `mid` / `high`) derived from it; the word and every narrated tell read them. A closed ENGINE enum, never player text and never a number: the narrator keeps voicing the existing mood word.
 * Pure: no rng, no I/O, no Vault.
 */
import { clamp01Raw as clamp01 } from "../domain/num";

/** The ACUTE state carries the real per-moment spread, so it leads the blend; the baseline pulls it. */
export const MOOD_ACUTE_WEIGHT = 0.62;
/** An acute crisis (state below this) always reads low, over everything. */
export const MOOD_DISTRESS = 0.22;
/** Band edges on the blended level: below LOW_EDGE reads low (the word "muted" and down), from HIGH_EDGE up reads high ("steady" and up); between is the middle ("even"). */
export const MOOD_LOW_EDGE = 0.49;
export const MOOD_HIGH_EDGE = 0.55;

export type MoodBand = "low" | "mid" | "high";

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);

/** The blended mood level (0..1): the moment leads, the season's trend pulls. `history` defaults to the acute value. */
export function moodLevel(emotionalState: number, emotionalHistory: readonly number[] = []): number {
  const acute = clamp01(emotionalState);
  const marinated = emotionalHistory.length ? clamp01(mean(emotionalHistory)) : acute;
  return clamp01(MOOD_ACUTE_WEIGHT * acute + (1 - MOOD_ACUTE_WEIGHT) * marinated);
}

/** The ONE band a soul's mood sits in; the word and the tells both read it. */
export function moodBandOf(emotionalState: number, emotionalHistory: readonly number[] = []): MoodBand {
  if (clamp01(emotionalState) < MOOD_DISTRESS) return "low";
  const level = moodLevel(emotionalState, emotionalHistory);
  return level < MOOD_LOW_EDGE ? "low" : level < MOOD_HIGH_EDGE ? "mid" : "high";
}
