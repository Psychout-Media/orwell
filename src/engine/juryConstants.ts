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
  /** ORW-638 (S-9): when a juror carries more than one grievance flag, each flag after the strongest counts at this share. 1 with a large `stackCapMult` restores the old flat sum (the kill switch). Dial: raise to shrink the change. */
  stackShare: 0.5,
  /** ORW-638 (S-9): the stacked grievance never exceeds this multiple of the single strongest flag (so betrayed + blindsided tops out at 0.75, not 1.1). */
  stackCapMult: 1.25,
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

/** B26 (flag ORWELL_JURY_MEMORY, ON by default): how much a juror's MEMORY of a finalist sways their lean. Added to the lean as a signed term (a grudge lowers, a favor raises), clamped to +-`max`. ASSUMED, pending Ryne. */
export const JURY_MEMORY = { scale: 1, max: 0.15 } as const;

/**
 * 0182 PR 3 (flag ORWELL_GRUDGES, played games only): a BITTER juror. The grudge book's freshness x severity, scaled by `scale`, lowers the juror's lean toward the finalist they hold it against,
 * clamped to `max`. ORW-957 (Ryne 2026-11-26: "I think it could out weigh. The way they walked out the door is just one factor. The way we played together all season is a huge part of the decision ... It should be
 * incredibly nuanced"): `max` is NO LONGER held under `|MANNER_LEAN.betrayed| x JURY_WEIGHTS.manner` (0.48): a deep, fresh grudge can out-vote a kind exit. It was 0.2; it is now 0.7, above the manner term, so a
 * full-strength grudge (freshness x severity of 1) can outweigh how the juror was treated on the way out, while a lesser one still only tilts a close vote. `scale` equals `max` on purpose: freshness x severity is at most 1, so the
 * term never saturates at the cap and every bit of easing (a mend) shows in the vote. The grudge adds only what the manner and memory terms do not already count (`bitterJurorExtra`), so a wrong already counted as
 * a grievance is never counted twice. The dial to retune if the played-game lane shifts win rates is `scale` ONLY (never `JURY_WEIGHTS.gameRespect`, see the 2026-06-21 calibration note).
 */
export const JURY_GRUDGE = { scale: 0.7, max: 0.7 } as const;

/**
 * ORW-943 (Ryne 2026-11-26: "2% of bitter jurors seems honestly kind of low ... it would really depend on the personality of the person"): how much a juror's grudge weighs depends on who the juror is. The multiplier
 * scales the grudge's signed lean (before it is netted against the manner and memory terms) by the juror's voting style, which already comes from their character (`juryMinds.jurorArchetypeFor`): a grudge-holder
 * takes a wrong far harder, a loyalist takes a betrayal personally, a forgiver lets most of it go. ORW-957: the product is NO LONGER held under the manner term (0.48): `ceiling` is only a sanity bound (1.0, a
 * full lean swing) so a deep grudge can out-vote how a juror was treated on the way out. Same rule for every finalist, the player included (parity); the juror is the only input. ASSUMED sizing, pending Ryne: the measured before/after is in the PR.
 */
export const JURY_GRUDGE_PERSONALITY = {
  byArchetype: { "grudge-holder": 3.0, loyalist: 1.8, competitor: 1.0, pragmatist: 0.7, forgiver: 0.3 },
  ceiling: 1.0,
} as const;

/**
 * ORW-129 (Ryne: "fades, leaves a trace") - what a `mend` appeal leaves behind. A mend used to dissolve a juror's MISTAKEN grievance completely; now most of it clears and a small lingering doubt remains:
 * the grievance is kept but its strength is multiplied by `residual`, so the juror leans a little less warmly toward the finalist than if it had never happened, forever above zero. ASSUMED, pending Ryne:
 * the residual share (0.15 = about a seventh of the original sting stays).
 */
export const MEND_TRACE = { residual: 0.15 } as const;
