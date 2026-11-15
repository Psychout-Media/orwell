import type { RandomnessSource } from "../ports/RandomnessSource";
import { clamp01 } from "./num";

/**
 * Temperature & emotional-modifier constants — the SINGLE tunable module (0028).
 *
 * 0006 fixed the *shape* (a bounded per-moment temperature roll + a soul-sourced
 * emotional modifier, no Luck stat) and proved the calibration; this fixes *the
 * numbers* and puts them in one place so the game's "swing" retunes without
 * touching logic — the sibling to the relationship constants (0026) and
 * `richnessConfig.ts`.
 *
 * Defaults match 0006's calibration: a clear favorite wins a strong ~72% majority
 * but loses real upsets, and the engine NEVER protects the player. Temperature is
 * bounded — it adds surprise but never overrides hard rules (eligibility, the
 * Vault Wall) or archetype-grounded weighting.
 */
export interface OutcomeWeights {
  stat: number;
  temperature: number;
  emotion: number;
  throwPenalty: number;
  playSafePenalty: number;
  /**
   * The hidden sleep cost (ADR 0006): a competitor's rest deficit (0..1) scales this into a bounded
   * score malus. #1419 owner ruling (2026-07-12) — staying up costs MORE at competitions: a full rest
   * deficit now shaves ~0.20 off the outcome score (against the stat weight of 1.0), on par with the
   * emotion weight — meaningful but never fatal, and never protective (a tired favorite can still lose).
   * Tuning, not architecture; 0 here would disable the sleep→comp consequence entirely.
   */
  sleepPenalty: number;
  /**
   * ORW-322 (Ryne 2026-11-12: "I think there should be a higher competition penalty... the longer you push back going to bed, that's when the sleep debt kicks in"): the CURVE of that malus over the graded rest
   * deficit d (0..1 = hours past midnight / 8): `min(cap, scale * d^exponent)`. Convex: gentle for a 1am chat (d=.125 -> .035), real by 2am (.10), harsh from 3am (.18) and 4am (.28), capped at `cap` so even an
   * all-nighter plays out (a very likely loss, never a guaranteed one). `sleepPenalty` above stays the on/off switch (0 disables the whole sleep -> comp consequence). Replaced the old linear `0.20 * d`.
   */
  sleepCurve: { scale: number; exponent: number; cap: number };
  /**
   * Feature 0127 (mixed-type competitions) — OPT-IN, DEFAULT-INERT AT RUNTIME. When a caller passes a
   * competition's SECONDARY aptitude (a genuine hybrid comp — "crawl through mud, then solve a puzzle"),
   * the score's stat base becomes a weighted blend: `primary·(1 − w) + secondary·w`, where `w` is this
   * weight. The PRIMARY stat still dominates (the winner is mostly the primary favorite), but a
   * well-rounded houseguest edges a one-dimensional one on hybrid comps. NO secondary passed ⇒ the base is
   * the pure single stat ⇒ BYTE-IDENTICAL to the pre-0127 model. Live callers pass it ONLY behind
   * `ORWELL_COMP_MIXED` (the calibration spine is byte-identical off; the band is re-confirmed on). A value
   * of `0` here disables the blend entirely (the alternate inert setting).
   */
  mixedSecondaryWeight: number;
}

export interface EmotionalConstants {
  /** The soul's stasis (decision 0001); 0.5 = calm baseline. */
  baseline: number;
  /** How hard circumstance + the temperature roll swing the modifier. */
  volatilityScale: number;
  /** How fast it settles back toward baseline when things calm (per calm moment). */
  meanReversionRate: number;
  /** How much of ADR 0001's per-moment roll enters a LIVE emotional swing (`evolveEmotion`, E52). */
  swingTemperatureWeight: number;
}

/**
 * Per-variable weighting: temperature is NOT one global multiplier (0028 §4). Every field here has
 * a REAL consumer (audit E53 — the decorative fields were deleted; a weight that drives nothing is
 * a lie in the config):
 *   - `initiative`    → the approach-ordering variance band (`conversation.ts` `rankApproaches`)
 *   - `allianceShift` → the near-tie wobble in bond-motivated picks (`RelationshipModel.chooseStrongestBond`)
 * Outcome temperature lives in `outcome.temperature`; secret surfacing in `hiddenSurfacingRate`;
 * relationship-fold variance in the 0026 `TEMPERATURE_JITTER`; emotional swing in
 * `emotional.swingTemperatureWeight`.
 */
export interface VariableWeights {
  initiative: number;
  allianceShift: number;
}

export interface TemperatureConstants {
  bound: { min: number; max: number };
  variableWeights: VariableWeights;
  outcome: OutcomeWeights;
  emotional: EmotionalConstants;
  /** Hidden elements surface RARELY, gated by the roll — bounded low (a treat, not a flood). */
  hiddenSurfacingRate: number;
}

export const TEMPERATURE_CONSTANTS: TemperatureConstants = {
  bound: { min: -1, max: 1 },
  // Values preserve the long-standing live behavior at the moment of wiring (E53): the approach
  // band was 1 ± 0.1 (= initiative/2) and the bond-pick wobble was ±0.05 (= allianceShift/2).
  variableWeights: { initiative: 0.2, allianceShift: 0.1 },
  // Calibrated so a clear stat favorite wins a majority but loses a real minority (0006). PO review
  // 2026-06-28: temperature raised 0.36 → 0.40 so upsets are a TAD more common and raw comp stats are
  // a bit less dominant now that character depth also lives in emotions (0041) + sleep (0066) — a clear
  // favorite drops from ~64% to ~59% average across field sizes (juryReach EARNED-WINS re-verified).
  outcome: { stat: 1.0, temperature: 0.40, emotion: 0.2, throwPenalty: 1.5, playSafePenalty: 0.2, sleepPenalty: 0.20, sleepCurve: { scale: 0.8, exponent: 1.5, cap: 0.6 }, mixedSecondaryWeight: 0.35 },
  emotional: { baseline: 0.5, volatilityScale: 0.5, meanReversionRate: 0.3, swingTemperatureWeight: 0.25 },
  hiddenSurfacingRate: 0.05,
};

// PERSIST-2/BE-101: guard NaN → 0 — `emotionalModifier` below is the ONE live soul-swing formula
// (audit E52); its result flows into the persisted `soul.emotionalState` via `emotionalArc.evolveEmotion`.
// A NaN circumstance/temperature input must never propagate. Finite inputs clamp exactly as before.
// (Kept as a local mirror, not an import, so `src/domain` stays engine-free per the hexagonal layering.)

/** One bounded, seeded temperature value (the per-moment roll). */
export function temperatureRoll(rng: RandomnessSource, c: TemperatureConstants = TEMPERATURE_CONSTANTS): number {
  return c.bound.min + rng.next() * (c.bound.max - c.bound.min);
}

export function withinTemperatureBounds(value: number, c: TemperatureConstants = TEMPERATURE_CONSTANTS): boolean {
  return value >= c.bound.min && value <= c.bound.max;
}

/**
 * The soul-sourced emotional modifier (0028 §5): a baseline that swings with
 * circumstance + temperature and MEAN-REVERTS toward baseline when calm. Passing
 * `circumstance = 0, temperature ≈ 0` is a calm moment — it settles toward
 * baseline. It is a competition input, never a fourth stat.
 *
 * Audit E52: this is now the ONE live swing formula — `evolveEmotion` (0041) delegates here, so
 * retuning `emotional.*` moves the whole game. `baseline` defaults to the global calm point but a
 * soul passes its OWN `emotionalBaseline` (every houseguest settles toward who they are).
 */
export function emotionalModifier(
  current: number,
  circumstance: number,
  temperature: number,
  c: TemperatureConstants = TEMPERATURE_CONSTANTS,
  baseline: number = c.emotional.baseline,
): number {
  const swung = clamp01(current + (circumstance + temperature) * c.emotional.volatilityScale);
  return swung + (baseline - swung) * c.emotional.meanReversionRate;
}

/** Whether a hidden element surfaces this moment — true RARELY (bounded by `hiddenSurfacingRate`). */
export function hiddenSurfaces(rng: RandomnessSource, c: TemperatureConstants = TEMPERATURE_CONSTANTS): boolean {
  return rng.next() < c.hiddenSurfacingRate;
}
