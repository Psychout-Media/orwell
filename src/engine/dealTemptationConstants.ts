/**
 * 0142 idea 4 - the tunable constants of "NPCs weigh breaking a deal" (`dealTemptation.ts`). One home so calibration reads one file.
 * Everything here is a HIDDEN magnitude (Vault-class): it never crosses to a player, prompt or admin surface.
 */
export const DEAL_TEMPTATION = {
  /** Temptation: the NPC's threat read of the player counts above this floor. */
  threatFloor: 0.4,
  threatWeight: 0.6,
  /** Temptation: a low bond (mean of trust and affinity) below this midpoint tempts. */
  bondMid: 0.5,
  lowBondWeight: 0.5,
  /** Temptation: the NPC's own standing plan against the player (campaign / held target drive), 0..1 push. */
  pushWeight: 0.5,
  /** Temptation: the agenda's pull on the player (`goalPull`, SIGNED: a protect goal or a long con before its break stage subtracts). FULL STRENGTH, like every other agenda read (Ryne 2026-11-12). */
  agendaWeight: 1.0,
  /** Temptation: the endgame (jury started / final five) makes a promise to a rival dear. */
  endgameJury: 0.1,
  endgameFinalFive: 0.25,
  /** How much the deal's kind scales temptation (a final-two promise is the heaviest to walk back; a vote promise the lightest). */
  kindScale: { safety: 1, vote: 0.8, "final-two": 0.9, "target-other": 1 } as Readonly<Record<string, number>>,
  /** Cost: being known as a liar. House credibility (mean `credibilityOf` over living NPCs, 1 = never caught lying) is what they stand to lose. */
  credibilityWeight: 0.4,
  /** Cost: the share of the house that credits them as a keeper of their word (the diffusing reliable-reputation belief). */
  reliableWeight: 0.3,
  /** Cost: the NPC's own bond with the player (a friend is dear). */
  bondWeight: 0.45,
  /** Cost: the NPC's own loyalty (character + mood), 0..1. */
  loyaltyWeight: 0.3,
  /** A quiet break: probability = clamp(slope * margin, 0, 1). The margin alone sets the chance (the card: a seeded decision from interest vs the price); the price of a bad call is already in the cost terms. */
  breakSlope: 0.5,
  /** Renegotiation: temptation at or above this with a margin that is NOT positive. */
  renegotiateFloor: 0.3,
  renegotiateSlope: 0.5,
} as const;
