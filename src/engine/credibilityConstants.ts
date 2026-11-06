/**
 * B48 (flag ORWELL_CREDIBILITY, default ON per the PO ruling 2026-11-05) - CREDIBILITY MEMORY. Every magnitude lives HERE (ASSUMED values, pending Ryne's review).
 * Ryne's card-24 ruling: NO arbitrary hard cap on lying (player or NPC). What limits a liar is what it COSTS: each lie an observer CAUGHT lowers how far that observer believes the liar (it fades with
 * time), and a speaker who keeps feeding the SAME ear is trusted less by that ear (the cost scales with repetition and with the recipient).
 */
export const CREDIBILITY = {
  /** Each caught lie multiplies the observer's belief in the speaker by (1 - perCaughtLie x severity x recency). */
  perCaughtLie: 0.35,
  /** A caught lie's weight halves every this many weeks (a stale lie is half-forgiven; never fully). */
  halfLifeWeeks: 4,
  /** Each lie the speaker has already told THIS listener (caught or not) multiplies the listener's belief by this - repetition to the same ear is suspicious. */
  perRepeatToListener: 0.8,
  /** Credibility never drops below this (a liar is never believed at exactly zero, and the engine never divides by it). */
  floor: 0.05,
  /** Technical bound on the evidence list read per pair (not a gameplay cap: far above a season's worth). */
  evidenceSafetyValve: 500,
} as const;
