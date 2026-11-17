import { JURY_FADE } from "./juryHouseConstants";

/**
 * ORW-582 - how much a juror's feelings fade (and their grudges ease) in the sequestered jury house.
 * ONE rule keyed by the HOLDER and what they hold (their forgiveness trait, their temperament, a seeded
 * per-person jitter); it never looks at WHO the subject is, so a juror fades toward the player exactly as
 * toward a finalist with the same history. Pure: no rng draw, no I/O, nothing shown to the player.
 */
export interface JuryPersonality {
  /** The holder is a grudge-keeper toward this subject (the existing forgiveness read). */
  keeper: boolean;
  /** The holder's soul volatility, 0..1 (a sentimental, intense holder is high). */
  volatility: number;
  /** A keyed hash roll in [0, 1) for this juror (`agendaRoll`-style), the per-person jitter. */
  roll: number;
}

const unit = (x: number): number => (Number.isNaN(x) ? 0.5 : Math.min(1, Math.max(0, x)));

/** The bounded personality multiplier on the jury-house fade: keepers least, easygoing most, mean about 1 for a typical holder. */
export function juryPersonalityMult(p: JuryPersonality): number {
  const jitter = 1 + JURY_FADE.jitter * (2 * unit(p.roll) - 1);
  const base = p.keeper
    ? JURY_FADE.keeperMult
    : JURY_FADE.easygoingMult + (JURY_FADE.sentimentalMult - JURY_FADE.easygoingMult) * unit(p.volatility);
  return base * jitter;
}

/** The nightly share a juror's feeling eases toward neutral (always below the in-house `OVERNIGHT_DRIFT.RATE`). */
export function juryFadeRate(p: JuryPersonality): number {
  return JURY_FADE.baseRate * juryPersonalityMult(p);
}

/** How much faster a juror's grudge eases than the same grudge in the house: at least 1, least for a keeper. */
export function juryEaseFactor(p: JuryPersonality): number {
  return 1 + JURY_FADE.easeGain * juryPersonalityMult(p);
}
