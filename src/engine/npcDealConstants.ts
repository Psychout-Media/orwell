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
  plan: {
    /** The holder's own chance of planning to break: base + weights on how little they trust the partner, how disloyal they are, and how many pacts they have already made (a prolific dealmaker leans to break). */
    breakBase: 0.08,
    trustMid: 0.6,
    lowTrustWeight: 0.6,
    loyaltyMid: 0.5,
    disloyalWeight: 0.5,
    dealCountWeight: 0.06,
    /** Among the plans to break a safety pact: the share that wait and flip next week; the rest break at this week's vote. */
    flipShareSafety: 0.45,
    /** Among the plans to break a final-two: the share that cut at the final three; then the share that break at the next nominations; the rest break at the vote. */
    cutShareFinalTwo: 0.4,
    nominationsShareFinalTwo: 0.3,
    /** Among the plans to keep a safety pact: the share that keep it for this week only. */
    thisWeekShare: 0.3,
  },
} as const;
