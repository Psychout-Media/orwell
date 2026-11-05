import type { EntityId } from "../domain/ids";
import { JURY_WEIGHTS, type JuryWeights } from "./juryConstants";
import { mannerLeanOf, type EvictionManner, type JuryRel } from "./jury";
import { fnv1a as fnv } from "../domain/num";

/**
 * A2 (design §13, behind `ORWELL_JUROR_PROFILES`, default OFF) - PER-JUROR vote profiles. One GLOBAL weight vector is the defect the jury-conversion diagnosis found:
 * every juror weighed comp-share, bond and grievance identically, so one dial (gameRespect 0.7) moved the whole house and no player behaviour but winning comps could
 * buy votes. Here each juror votes by their OWN personality: a *competitor* weighs the game resume, a *loyalist* weighs bond and demonstrated loyalty, a *grudge-holder*
 * weighs how they were treated on the way out, a *forgiver* discounts a grievance when the finalist was a friend, a *pragmatist* is swayed by the finale. A player can
 * therefore win a COALITION of jurors (the bond-heavy and the forgiving) while losing the competitors - conversion emerges from who was cultivated, not from a knob.
 *
 * PURE and DETERMINISTIC: a juror's archetype and jitter come from a stable hash of their id (the CHARACTER-static analogue - no rng, so the shared seeded stream is never
 * drawn from and the ballot draw count is identical ON or OFF). NORMALISED: the five archetype multiplier rows sum to exactly 5.0 per term, so the HOUSE-MEAN weight of
 * every term is unchanged (the passive-conversion constraint, design §13.5); only the DISTRIBUTION across jurors changes. FRIEND-FORGIVES (PO-approved): a juror's net
 * grievance is scaled by `1 - forgiveness * bondToTarget`, so a close friend discounts a blindside; a stranger does not. Vault-free: a profile is hidden state, no number
 * ever crosses to the player.
 */
export type JurorArchetype = "competitor" | "loyalist" | "grudge-holder" | "forgiver" | "pragmatist";

export interface JurorProfile {
  archetype: JurorArchetype;
  /** Multipliers on the ballot's term weights (mean 1.0 across the five archetypes, per term). */
  mult: { relationship: number; manner: number; reliability: number; gameRespect: number; finale: number };
  /** 0..1 - how much a close bond discounts a grievance (friend-forgives). */
  forgiveness: number;
}

// Each COLUMN sums to 5.0 (the house-mean weight of every term is preserved). Ordered: relationship, manner, reliability, gameRespect, finale, forgiveness.
export const ARCHETYPES: ReadonlyArray<readonly [JurorArchetype, number, number, number, number, number, number]> = [
  ["competitor",    0.85, 0.90, 0.90, 1.60, 1.00, 0.20],
  ["loyalist",      1.35, 1.00, 1.40, 0.70, 0.80, 0.50],
  ["grudge-holder", 0.90, 1.40, 1.00, 0.90, 0.90, 0.00],
  ["forgiver",      1.00, 0.70, 0.90, 1.00, 1.00, 0.70],
  ["pragmatist",    0.90, 1.00, 0.80, 0.80, 1.30, 0.30],
];


/** The juror's static profile: archetype from the id hash (uniform over the five), no rng. */
export function jurorProfile(juror: EntityId, salt: string | number = 0): JurorProfile {
  const [archetype, relationship, manner, reliability, gameRespect, finale, forgiveness] = ARCHETYPES[fnv(`${salt}|${juror}|archetype`) % ARCHETYPES.length]!;
  return { archetype, mult: { relationship, manner, reliability, gameRespect, finale }, forgiveness };
}

/** The juror's OWN weight vector: the global `JURY_WEIGHTS` scaled term by term by their profile. */
export function profiledWeights(profile: JurorProfile, base: JuryWeights = JURY_WEIGHTS): JuryWeights {
  return {
    relationship: base.relationship * profile.mult.relationship,
    manner: base.manner * profile.mult.manner,
    reliability: base.reliability * profile.mult.reliability,
    gameRespect: base.gameRespect * profile.mult.gameRespect,
    finale: base.finale * profile.mult.finale,
  };
}

/**
 * The juror's lean toward one finalist under THEIR profile: relationship + manner + reliability each at the juror's own weight, with FRIEND-FORGIVES - a NET grievance
 * (the signed manner lean below zero) is discounted by `forgiveness * bond`, bond = (trust + affinity) / 2. A positive manner lean (respect, a warm goodbye) is untouched.
 * (The game-respect term is added by the caller with `profiledWeights(...).gameRespect`, exactly where the global term sits today.)
 */
export function profiledLean(rel: JuryRel, manner: EvictionManner, profile: JurorProfile, base: JuryWeights = JURY_WEIGHTS): number {
  const w = profiledWeights(profile, base);
  const bond = (rel.trust + rel.affinity) / 2;
  let m = mannerLeanOf(manner);
  if (m < 0) m *= 1 - profile.forgiveness * Math.max(0, Math.min(1, bond));
  return w.relationship * bond + w.manner * m + w.reliability * (rel.reliability ?? 0);
}
