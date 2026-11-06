/**
 * Jury & finale magnitudes — the SINGLE tunable constants module (features 0014 / 0037),
 * mirroring `relationshipConstants.ts`. **Every number the jury vote + finale sway use lives
 * here**: the three vote-term WEIGHTS, the eviction-MANNER lean shifts, the manner-read
 * THRESHOLDS, and the engine-scored finale APPEAL magnitudes. The shape is fixed in `jury.ts`
 * and `liveSeason.ts`; the numbers are config — retune the finale feel (or wire a future
 * God-Mode knob, 0016) without touching the logic. The player never sees any of these (0020).
 */

/** Relative weights of the four vote terms. The finale is deliberately small: it sways, never dominates. */
export interface JuryWeights {
  relationship: number;
  manner: number;
  /** Deliberately small vs relationship+manner: the finale sways, it doesn't dominate. */
  finale: number;
  /**
   * GAME RESPECT (D4/E33 ruling, 2026-06-11): how hard jurors weigh the public game resume
   * (comp wins) between the two finalists. The signed term is bounded (±0.5 before the weight),
   * sized so a no-game goat loses a neutral jury — while a deeply WRONGED jury (betrayal/blindside
   * manners) can still go bitter and crown the goat: real-BB juries do both.
   */
  gameRespect: number;
  /**
   * RELIABILITY (ADR 0002's evidence signal, E54 consumption tail): a juror leans toward a finalist
   * who DEMONSTRATED loyalty toward them — honored a deal, protected them, saved them — beyond mere
   * sentiment. Signed/centered on the edge baseline (a no-track-record juror reads neutral). Sized
   * BELOW relationship+manner: proof reinforces a lean, it does not eclipse how the game actually went.
   */
  reliability: number;
}

export const JURY_WEIGHTS: JuryWeights = { relationship: 1.0, manner: 0.8, finale: 0.3, gameRespect: 0.7, reliability: 0.4 };

/**
 * How the MANNER of a finalist's eviction move shifts a juror's lean toward them (signed; `juryLean`).
 * Feeling respected lifts the lean; a blindside/betrayal/disrespect pulls it down (betrayal hardest).
 */
export const MANNER_LEAN: Readonly<Record<"respected" | "blindsided" | "betrayed" | "disrespected", number>> = {
  respected: 0.4,
  blindsided: -0.5,
  betrayed: -0.6,
  disrespected: -0.4,
};

/** Thresholds an evictee reads a responsible houseguest's move by (`mannerToward`, liveSeason). */
export const MANNER_THRESHOLDS = {
  /** Trusted them at least this much, yet they moved against me ⇒ betrayed. */
  trustBetrayal: 0.5,
  /** Read them as below this much of a threat, so I never saw it coming ⇒ blindsided. */
  threatBlindside: 0.4,
} as const;

/**
 * SOC-NEW-1/5 — the manner read is DYNAMIC on the actual relationship, not flat booleans summed.
 * Two things are graded off the game numbers: a grievance's SEVERITY (a deeply-trusted betrayal
 * stings more than a marginal one) and a clean cut's RESPECT (a feared rival earns it; an ignored
 * floater nets ~neutral, not a flat lift). And the goodbye is applied with bounded PRECEDENCE — a
 * warm send-off can soften a betrayal's sting but can NEVER launder it positive (the prior additive
 * merge let a costless warm tone cancel ~40% of a betrayal). The player never sees any of these (0020).
 */
export const MANNER_GRADING = {
  /**
   * The floor a categorical GRIEVANCE (betrayal/blindside) is graded down to. Severity scales from
   * this floor (a just-over-threshold move) to 1.0 (a total betrayal / a total blindside) — a real
   * betrayal is never trivialized toward zero, but how badly it landed tracks the relationship.
   */
  grievanceFloor: 0.55,
  /**
   * A warm/respectful goodbye softens a standing grievance by AT MOST this fraction — PRECEDENCE,
   * not addition. The lean can ease toward zero but never crosses it: a kind word is the last thing
   * said, not a pardon for the move that put them on the block.
   */
  goodbyeSoftenMax: 0.25,
  /** A warm/respectful goodbye's small independent LIFT on a clean (non-grievance) departure. */
  goodbyeWarmLift: 0.12,
  /** A cold goodbye's independent STING — its own minor grievance, never itself laundered away. */
  goodbyeColdSting: 0.18,
} as const;

/** Engine-scored finale APPEAL magnitudes (`appealEffect`), all bounded to [0,1]. */
export const APPEAL = {
  /** `mend` lands on a grievance (blindside/betrayal/disrespect); is mostly wasted without one. */
  mendGrievance: 0.85,
  mendNoGrievance: 0.35,
  /** `connect` scales with the juror's affinity for the finalist. */
  connectBase: 0.4,
  connectAffinity: 0.4,
  /** `own-game` backfires on the betrayed; else lands with jurors who respect a threatening, fair game. */
  ownGameBetrayed: 0.3,
  ownGameBase: 0.55,
  ownGameThreat: 0.2,
  /** `discredit-rival` is a small generic lift that backfires with a juror loyal to the rival. */
  discreditLoyalToRival: 0.35,
  discreditBase: 0.55,
  /** A juror with affinity ABOVE this for the rival reads as loyal ⇒ discredit backfires. */
  discreditLoyaltyThreshold: 0.6,
} as const;

/** B26 (flag ORWELL_JURY_MEMORY, off by default): how much a juror's MEMORY of a finalist sways their lean. Added to the lean as a signed term (a grudge lowers, a favor raises), clamped to +-`max`. ASSUMED, pending Ryne. */
export const JURY_MEMORY = { scale: 1, max: 0.15 } as const;

/**
 * ORW-129 (Ryne: "fades, leaves a trace") - what a `mend` appeal leaves behind. A mend used to dissolve a juror's MISTAKEN grievance completely; now most of it clears and a small lingering doubt remains:
 * the grievance is kept but its strength is multiplied by `residual`, so the juror leans a little less warmly toward the finalist than if it had never happened, forever above zero. ASSUMED, pending Ryne:
 * the residual share (0.15 = about a seventh of the original sting stays).
 */
export const MEND_TRACE = { residual: 0.15 } as const;
