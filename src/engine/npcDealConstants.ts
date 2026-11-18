/**
 * Feature 0170 (Theme 3 slice 2, flag ORWELL_NPC_DEALS) - every number the NPC-to-NPC pact proposal reads, in one place so the owner can retune without a code hunt.
 * Hidden mechanics: none of this ever reaches a player, a prompt or a tool result. `DECISION.npcDeal` keeps the numbers of the single-pact path that runs with the flag off.
 */
export const NPC_DEALS = {
  /** The most NEW pacts the house may seal in one week (on top of the single legacy pact). */
  pairCapPerWeek: 3,
  /** A pair's MUTUAL trust must clear this floor before they are even considered. */
  mutualTrustMin: 0.4,
  /** At or above this mutual trust the pact is a final-two; below, a week-scoped safety pact. */
  finalTwoTrustMin: 0.72,
  /** Chance a considered pair seals a pact: base plus a rise with the mutual trust above the floor and with the felt warmth. */
  proposeBase: 0.12,
  proposePerTrust: 0.5,
  proposePerWarmth: 0.15,
} as const;

/**
 * ORW-614 follow-up (flag ORWELL_DEAL_COUNTER) - when the player's counter to a standing offer is REFUSED, does the original offer still stand? The houseguest's own temperament decides
 * (hidden; never shown): a touchy houseguest (high soul volatility) or an unsteady one (low emotional steadiness) pulls it, a calm and steady one keeps it open.
 */
export const COUNTER_STANDS = {
  /** The chance the offer stands for a houseguest of middling volatility and steadiness. */
  base: 0.5,
  /** How far volatility above/below the middle lowers/raises the chance (a touchy houseguest takes a refused counter as an insult). */
  perVolatility: 0.5,
  /** How far steadiness above/below the middle raises/lowers the chance. */
  perSteadiness: 0.3,
  /** The band the chance is held in so both outcomes stay possible for every houseguest (never exactly 0 or 1). */
  floor: 0.08,
  ceiling: 0.92,
} as const;
