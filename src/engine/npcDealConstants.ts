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
