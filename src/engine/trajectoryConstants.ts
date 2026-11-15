/**
 * Relationship-TRAJECTORY tunables — the SINGLE tunable module for feature 0087 (the B59 `*Constants`
 * sibling grep gate). 0026 fixed how a relationship's POSITION moves (per-interaction impacts, decay,
 * betrayal-shock); this fixes how its MOMENTUM moves: the recency window that defines the current
 * `phase`, how fast momentum builds vs. decays toward `steady`, the per-phase continuation-bias
 * weights, and the bounded, momentum-scaled tilt CAP that nudges off-screen scene-nature selection
 * toward continuing the arc.
 *
 * Everything the pure `deriveTrajectory` / `tiltNatureWeights` use lives HERE — retune the feel (or
 * wire a future God-Mode knob) without touching the logic. The shape is fixed; the numbers are config.
 * The player NEVER sees any of these (mandate #2: momentum is Vault-class hidden state).
 *
 * Defaults (owner-recommended at build, spec §"Open questions"): a SHORT recency window (the last 3–4
 * folds define the arc), momentum building GRADUALLY but SPIKING on a betrayal (the 0026 BETRAYAL_SHOCK
 * is the natural injector), decaying toward `steady` at the 0026 neglect cadence, and a TIGHT tilt cap
 * — enough to deepen arcs (criterion 1) without flattening the society's variety or railroading
 * (criterion 2: a strong tie still produces off-arc beats).
 */
import type { InteractionType } from "./relationshipConstants";

export interface TrajectoryConstants {
  /**
   * How many recent folds define the current `phase` (≈ last 3–4). A short window keeps the arc
   * RESPONSIVE — a few consistent scenes set a direction, a contradicting run flips it — rather than a
   * slow-moving average that lags the relationship.
   */
  recencyWindow: number;
  /**
   * Momentum BUILD rate per consistent fold (0..1): how much one arc-consistent scene adds to momentum.
   * Gradual — a string of warm (resp. souring) scenes accrues a real arc; one scene barely moves it.
   */
  buildRate: number;
  /**
   * Momentum DECAY toward `steady` when a pair is NEGLECTED (no fold this tick) — mirrors 0026's edge
   * decay cadence (`DECAY_RATE`), so an unfed arc reverts to a flat relationship at the same pace warmth
   * fades. Applied per neglected tick by the engine-side momentum update.
   */
  neglectDecay: number;
  /**
   * The momentum a BETRAYAL injects in one shot (the spike). A betrayal is the natural souring-momentum
   * injector (spec): the moment a bond curdles, the arc commits hard — this is the souring analog of the
   * 0026 BETRAYAL_SHOCK, so a single betrayal can set a strong souring arc where a string of mild
   * conflicts would build one only gradually.
   */
  betrayalSpike: number;
  /**
   * The minimum NET edge movement (bond delta magnitude, summed over the window) for a non-`steady`
   * phase. Below this the recent run is noise, not a direction ⇒ `steady` (no tilt). Keeps a barely-moving
   * pair flat rather than reading drift as an arc.
   */
  phaseFloor: number;
  /**
   * `souring` (vs. plain `cooling`) requires the bond to be falling AND threat rising — the CURDLE. This
   * is the minimum threat-rise share of the window's movement that distinguishes a hostile curdle from a
   * cordial drift-apart. At/above ⇒ `souring`; a bond falling with little threat ⇒ `cooling`.
   */
  souringThreatShare: number;
  /**
   * The TILT CAP — the maximum fraction a fully-committed (`momentum` = 1) arc may add to (or remove
   * from) a nature's continuation weight, as a multiple of that nature's CURRENT weight. The tilt is
   * `weight × (1 ± cap × momentum × bias)`, so it scales BOTH with momentum and with the nature's
   * existing propensity — it bends an already-plausible nature, never manufactures one from zero (a
   * gated betrayal stays gated; spec criterion 2). Tight enough that off-arc beats stay possible.
   */
  tiltCap: number;
  /**
   * Per-phase continuation-bias weights per nature (the spec's phase→tilt table). `> 0` up-weights the
   * nature (continue the arc), `< 0` down-weights it (resist reversal), `0`/absent leaves it untouched.
   * The magnitude is the bias `b` in the tilt formula above; the engine clamps the result ≥ 0. `steady`
   * is intentionally EMPTY — exactly today's `natureWeights`, no tilt.
   */
  bias: Record<TrajectoryPhase, Partial<Record<InteractionType, number>>>;
  /**
   * ORW-336b (the momentum-properties pass; ABSENT on the off-screen arcs, so they are byte-identical): the ceiling an ordinary
   * run may build momentum to. A long streak plateaus here instead of climbing to 1 - "no radicalization": nobody ends up
   * loving or hating the player on momentum alone. A betrayal's spike may sit above it (it is a one-off, and decays).
   */
  momentumCap?: number;
  /**
   * ORW-336b: when the window's direction FLIPS (warming <-> cooling/souring) momentum starts fresh instead of carrying the
   * old arc's momentum across the flip, so a turnaround is gradual and the new arc cannot begin near its maximum.
   */
  flipReset?: boolean;
  /**
   * ORW-336b: a fold that OPPOSES the arc's current direction (a warm scene during a cooling arc, an apology) cuts the carried
   * momentum by this fraction at once (0..1), so one change of heart visibly takes the wind out of the arc rather than being
   * outvoted by the older scenes still in the window. Absent/0 = no damping.
   */
  opposeDamp?: number;
}

/** The arc's current direction (spec). `steady` ⇒ no tilt (byte-identical to today's `natureWeights`). */
export type TrajectoryPhase = "warming" | "cooling" | "souring" | "steady";

export const TRAJECTORY_CONSTANTS: TrajectoryConstants = {
  recencyWindow: 4,
  buildRate: 0.28,
  neglectDecay: 0.05, // == RELATIONSHIP_CONSTANTS.DECAY_RATE — an unfed arc fades at the neglect cadence
  betrayalSpike: 0.6, // a betrayal commits the arc hard in one shot (the souring injector)
  phaseFloor: 0.08, // below this net movement the run is noise, not a direction → steady
  souringThreatShare: 0.35, // a curdle (souring) needs real threat rising, not just a cordial cooling
  tiltCap: 0.6, // ≤60% of a nature's own weight at full momentum — bends probabilities, never railroads
  bias: {
    // warming: up-weight the warm/closer natures; resist the hostile ones.
    warming: { bonding: 1.0, showmance: 0.8, alliance: 0.6, conflict: -0.8, betrayal: -1.0 },
    // cooling: a cordial drift-apart — more friction, less warmth (NOT a betrayal escalation).
    cooling: { conflict: 0.8, bonding: -0.7, showmance: -0.8 },
    // souring: the curdle — push conflict and (only where the 0078 gate already permits) betrayal; kill warmth.
    souring: { conflict: 1.0, betrayal: 0.8, bonding: -1.0, showmance: -1.0 },
    // steady: NO tilt — exactly today's natureWeights.
    steady: {},
  },
};

/**
 * ORW-336 (0087, NPC->player momentum): how far the hidden arc toward the PLAYER bends an NPC's movement. `gain` scales
 * the pull weight by `1 + gain x momentum` (momentum <= 1, so at most x1.6 - a tilt, never a railroad); below
 * `minMomentum` the arc is noise and nothing changes. Sits beside the 0078 `MOVEMENT_MEMORY` memory tilt it mirrors.
 */
export const TRAJECTORY_PLAYER_APPROACH = { minMomentum: 0.15, gain: 0.6 } as const;

/**
 * ORW-336b - the constants for the NPC->PLAYER arcs ONLY (the off-screen NPC<->NPC arcs keep `TRAJECTORY_CONSTANTS`, so headless
 * seeded sims are byte-identical). Ryne's rule: momentum must not radicalize ("they either really love you or hate you"); an arc
 * can be turned by an apology or a deep talk, and it can simply stay flat. So: a modest ceiling (0.5 => the movement tilt is at
 * most 1 + 0.6 x 0.5 = x1.3), a flip starts fresh, an opposing scene halves the momentum, and an unfed arc fades fast (0.2 per
 * tick: ~9 ticks from the ceiling) instead of the 0.05 neglect cadence (~49 ticks).
 */
export const PLAYER_ARC_CONSTANTS: TrajectoryConstants = {
  ...TRAJECTORY_CONSTANTS,
  neglectDecay: 0.2,
  momentumCap: 0.5,
  flipReset: true,
  opposeDamp: 0.5,
};
