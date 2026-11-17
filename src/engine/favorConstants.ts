/**
 * 0171 / Theme 3 slice 3 - the tunable numbers of counters and the favor economy, in ONE place (no number lives inline in `favors.ts` / `favorCounters.ts`).
 * Engine-only: nothing here, and nothing derived from it, is ever shown to the player as a number, a tally or a ledger.
 */
export const FAVOR = {
  /** The most counters one negotiation can trade. A round past this is never a counter: the side either settles or lets it fall through. */
  maxCounterRounds: 3,
  /** A weekly goal pulls hard enough to ask for something in return only above this pull (the same scale as a threat read). */
  askFloor: 0.15,
  /** The chance a houseguest with a goal counters, at the floor, and the extra chance per unit of pull above it. */
  counterBase: 0.35,
  counterSlope: 1.2,
  /** Settling when no counter is made: the chance an offer is taken at zero bond, and the extra chance per unit of bond (0..1). */
  settleBase: 0.45,
  settleBondSlope: 0.5,
  /** An ask to put someone up is conceded when the responder's own pull on that person is at or above this (they would not mind); below it they protect them. */
  concedePull: 0,
  /** One owed favor moves the bond's debt by this much (signed, clamped to -1..1). */
  debtPerFavor: 0.25,
  /** A favor owed is called in only when the holder is on the block at a close vote; the debtor honors it with this base chance, plus loyalty and bond, minus the threat they read in the holder. */
  honorBase: 0.45,
  honorLoyaltySlope: 0.3,
  honorBondSlope: 0.25,
  honorThreatSlope: 0.4,
  /** The shield an honored favor adds against evicting the holder at that vote: this share of a formal deal's honor weight. */
  shieldShareOfDealHonor: 0.6,
  /** Refusing a called-in favor costs the holder's trust in the debtor at this share of a betrayal-shock; a witness takes the existing deal witness factor of it. */
  refusalScale: 0.6,
  /** A holder not on the block passes a favor to a nominee they are at least this close to (rel.bondStrength). */
  passBond: 0.6,
} as const;
