/**
 * RELATIONSHIP TRAJECTORIES (feature 0087) — a directed bond has MOMENTUM, not just a position.
 *
 * Alongside the 0002 directed edge (`EdgeSignals` — the POSITION) the engine keeps a small, hidden,
 * engine-owned MOMENTUM term: the direction the bond is MOVING. It biases off-screen scene-NATURE
 * selection so consecutive scenes between a pair tend to CONTINUE the arc (a curdling friendship gets
 * more clash scenes as it cools) rather than whiplash bond → clash → bond.
 *
 * THIS MODULE IS PURE + ENGINE-ONLY (Vault-sealed). It takes NO rng — momentum is a deterministic read
 * of already-folded history — does NO I/O, and holds NO Vault handle. `phase`/`momentum` are Vault-class
 * hidden state (mandate #2): they appear on NO player- or admin-facing projection and reach the player
 * ONLY through behavior (the kinds of scenes that happen, the tone the model voices). No outward surface
 * may import this (dependency-cruiser).
 *
 * The single behavioral mechanism is `tiltNatureWeights`: it RE-WEIGHTS the existing `natureWeights`
 * propensities toward natures that continue the current `phase`, scaled by `momentum`, BOUNDED by a
 * tunable cap (`TRAJECTORY_CONSTANTS.tiltCap`). It adds ZERO rng draws and consumes none — the same
 * single nature `weightedPick` happens, only its weights differ — so with trajectories ON the off-screen
 * stream's draw count/order is unchanged and the seeded competition/vote spine reading that same stream
 * stays in phase (the calibration-neutrality constraint; `tests/unit/trajectoryOutcomeNeutral.test.ts`).
 */
import type { InteractionType } from "./relationshipConstants";
import { clamp01 } from "../domain/num";
import {
  TRAJECTORY_CONSTANTS,
  type TrajectoryConstants,
  type TrajectoryPhase,
} from "./trajectoryConstants";

export type { TrajectoryPhase };

/**
 * The hidden momentum term held beside a directed edge. `momentum` ∈ [0,1] — how committed the arc is
 * (how strongly it resists reversal). VAULT-ONLY: never shown, never crossed to player or admin.
 */
export interface Trajectory {
  phase: TrajectoryPhase;
  momentum: number;
}

/** A pair with no history yet — flat, no momentum (the pre-feature / pre-0087-save resume state). */
export const STEADY: Trajectory = { phase: "steady", momentum: 0 };

/**
 * A single FOLDED scene's contribution to a directed arc — the minimal, Vault-free signal `deriveTrajectory`
 * reads. Computed engine-side from the scene's nature at fold time (NOT from any raw edge number that could
 * cross a wall): how far the bond moved (`bondDelta`, signed: + warmer, − cooler), how far the danger read
 * moved (`threatDelta`, signed), and whether this was a BETRAYAL (the souring-momentum injector). One entry
 * per fold; the engine keeps only the last `recencyWindow` (a tiny ring buffer per pair).
 */
export interface FoldSignal {
  bondDelta: number;
  threatDelta: number;
  betrayal: boolean;
}

// PERSIST-2/BE-101: guard NaN → 0 — this clamp gates the persisted `Trajectory.momentum` (kept beside
// the relationship edges, recalled across restarts). Finite inputs clamp exactly as before.

/**
 * Derive a directed relationship's TRAJECTORY (PURE, no rng) from its recent folded history + its prior
 * momentum. `recentFolds` is earliest→latest, already trimmed to the recency window by the caller (extra
 * entries are harmless — only the last `recencyWindow` are read).
 *
 *  - PHASE: the sign of the windowed NET bond movement sets warming (rising) vs. falling. A fall with real
 *    threat rising (`souringThreatShare` of the movement) is `souring` (the curdle); a fall with little
 *    threat is the cordial `cooling`. Net movement below `phaseFloor` ⇒ `steady` (noise, not a direction).
 *  - MOMENTUM: builds with the CONSISTENCY of the recent run (each arc-consistent fold adds `buildRate`),
 *    SPIKES on a betrayal (`betrayalSpike`), and otherwise carries the prior momentum forward (sticky).
 *    `deriveTrajectory` never APPLIES neglect-decay (that is a per-tick engine step on ticks with no fold);
 *    here a fold happened, so the arc is being fed.
 *
 * Determinism: same `recentFolds` + same `prior` ⇒ same `phase`/`momentum` (criterion 5). No wall-clock.
 */
export function deriveTrajectory(
  recentFolds: readonly FoldSignal[],
  prior: Trajectory | undefined,
  c: TrajectoryConstants = TRAJECTORY_CONSTANTS,
): Trajectory {
  const window = recentFolds.slice(-c.recencyWindow);
  if (window.length === 0) return prior ?? STEADY;

  let netBond = 0;
  let threatUp = 0;
  let absMove = 0;
  let anyBetrayal = false;
  // Consistency: how many folds agree with the window's DOMINANT bond direction (sets momentum build).
  let warmCount = 0;
  let coolCount = 0;
  for (const f of window) {
    netBond += f.bondDelta;
    if (f.threatDelta > 0) threatUp += f.threatDelta;
    absMove += Math.abs(f.bondDelta);
    if (f.betrayal) anyBetrayal = true;
    if (f.bondDelta > 0) warmCount++;
    else if (f.bondDelta < 0) coolCount++;
  }

  // PHASE — direction from the net bond movement; the curdle distinction from the threat share.
  let phase: TrajectoryPhase;
  if (Math.abs(netBond) < c.phaseFloor && !anyBetrayal) {
    phase = "steady";
  } else if (netBond > 0 && !anyBetrayal) {
    phase = "warming";
  } else {
    // Falling (or a betrayal): is the danger read rising enough to call it a curdle?
    const threatShare = absMove > 0 ? threatUp / absMove : (anyBetrayal ? 1 : 0);
    phase = anyBetrayal || threatShare >= c.souringThreatShare ? "souring" : "cooling";
  }

  // MOMENTUM — consistency build + the betrayal spike, carried from the prior (sticky), then clamped.
  // A `steady` window bleeds momentum toward 0 (the run lost its direction) but does not zero it instantly.
  const dominant = Math.max(warmCount, coolCount);
  const consistency = window.length > 0 ? dominant / window.length : 0;
  const priorM = prior?.momentum ?? 0;
  let momentum: number;
  if (phase === "steady") {
    momentum = priorM * (1 - c.buildRate); // a directionless run lets momentum lapse toward flat
  } else {
    const built = priorM + c.buildRate * consistency;
    momentum = anyBetrayal ? Math.max(built, c.betrayalSpike) : built;
  }
  return { phase, momentum: clamp01(momentum) };
}

/**
 * Apply NEGLECT decay to a trajectory for a tick in which the pair had NO folded scene (PURE). Mirrors
 * 0026's edge decay: an unfed arc reverts toward `steady` at the neglect cadence. When momentum reaches
 * ~0 the phase collapses to `steady` (a flat relationship). Called by the engine-side per-tick update on
 * pairs that did not interact this tick; takes no rng.
 */
export function decayTrajectory(prior: Trajectory, c: TrajectoryConstants = TRAJECTORY_CONSTANTS): Trajectory {
  const momentum = prior.momentum * (1 - c.neglectDecay);
  if (momentum < c.phaseFloor) return STEADY;
  return { phase: prior.phase, momentum };
}

/**
 * Re-weight scene-nature propensities toward continuing the trajectory's arc (PURE, no rng). Given the
 * natures (the `RICH_TYPES` order) and `natureWeights`'s output for them, returns a NEW weights array in
 * which each nature is scaled by `1 + tiltCap × momentum × bias[phase][nature]`, clamped ≥ 0:
 *
 *   - a continuation nature (bias > 0) is up-weighted; a reversal nature (bias < 0) is down-weighted;
 *   - the effect scales with `momentum` (a committed arc bends harder) AND with the cap (bounded);
 *   - it scales the nature's OWN current weight, so a nature already at zero stays zero — a gated betrayal
 *     (0078: weight 0 unless the prior-bond + incentive floor is met) can NEVER be manufactured by
 *     souring momentum (spec criterion 2 / the betrayal-gate invariant); momentum only re-weights
 *     ELIGIBLE natures.
 *
 * `steady` (empty bias) ⇒ the weights are returned UNCHANGED (byte-identical to today's `natureWeights`).
 * Draw-count-stable: the caller's single `weightedPick` over these weights takes the same one rng draw as
 * before — only which nature it lands on shifts. Same length in, same length out.
 */
export function tiltNatureWeights(
  natures: readonly InteractionType[],
  weights: readonly number[],
  trajectory: Trajectory,
  c: TrajectoryConstants = TRAJECTORY_CONSTANTS,
): number[] {
  const biasFor = c.bias[trajectory.phase];
  // Fast path: a steady (or no-bias) arc and/or zero momentum is the identity — exactly today's weights.
  if (trajectory.momentum <= 0 || !biasFor || Object.keys(biasFor).length === 0) {
    return [...weights];
  }
  return weights.map((w, i) => {
    const bias = biasFor[natures[i]!] ?? 0;
    if (bias === 0) return w;
    const factor = 1 + c.tiltCap * trajectory.momentum * bias;
    const out = w * factor;
    return out > 0 ? out : 0; // clamp ≥ 0 — never re-animate a gated-to-zero nature, never go negative
  });
}
