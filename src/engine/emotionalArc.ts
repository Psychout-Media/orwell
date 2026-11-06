import type { Soul, Disposition } from "./characterFactory";
import type { InteractionType } from "./relationships";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { TEMPERATURE_CONSTANTS, emotionalModifier, temperatureRoll } from "../domain/temperatureConstants";
import type { TemperatureConstants } from "../domain/temperatureConstants";
import { clamp01 } from "../domain/num";

/**
 * Character evolution & season arc (feature 0041) — the LIVE emotional layer.
 *
 * A season should *change* a houseguest. Consequential events move their hidden soul
 * `emotionalState` (a 0..1 confidence−distress scalar; 0.5 = calm baseline) and `volatility`;
 * a calm stretch mean-reverts them toward baseline. This is the sibling to the 0028
 * competition emotional modifier — it reuses the SAME tunable constants
 * (`emotional.volatilityScale`, `meanReversionRate`, `baseline`), so the game's "swing"
 * retunes in one place. It is BOUNDED ([0,1]) and never overrides a hard rule (0005) or the
 * Vault Wall (0001) — the player feels the change only through later behavior, never a number.
 *
 * Only the dynamic SOUL drifts; the static CHARACTER baseline is untouched (0007).
 */
export type EmotionalEvent =
  | "blindside"      // an eviction you never saw coming — rattling
  | "betrayed"       // an ally moved against you / broke a deal
  | "nominated"      // put on the block — exposed and rattled going into the veto (B51)
  | "comp-loss"      // lost a competition you contested
  | "scheme"         // an off-screen scheming scene — low-grade agitation
  | "calm"           // a quiet stretch — settle toward baseline
  | "bond"           // an off-screen bonding scene — steadying
  | "survived-vote"  // sat on the block and survived — emboldening
  | "comp-win";      // won a competition — confidence

interface Impact {
  /** Moves `emotionalState`: − toward distress, + toward confidence. */
  valence: number;
  /** Moves `volatility`: + more volatile (shock), − settling. */
  arousal: number;
}

const IMPACT: Record<EmotionalEvent, Impact> = {
  blindside:       { valence: -0.6,  arousal: +0.5 },
  betrayed:        { valence: -0.5,  arousal: +0.45 },
  nominated:       { valence: -0.35, arousal: +0.25 },
  "comp-loss":     { valence: -0.2,  arousal: +0.1 },
  scheme:          { valence: -0.05, arousal: +0.2 },
  calm:            { valence:  0.0,  arousal: -0.3 },
  bond:            { valence: +0.15, arousal: -0.15 },
  "survived-vote": { valence: +0.4,  arousal: -0.1 },
  "comp-win":      { valence: +0.45, arousal: +0.05 },
};

/** Which side of an off-screen scene a soul stood on (audit E50): roles feel DIFFERENT things. */
export type SceneRole = "initiator" | "partner";

/**
 * How an off-screen scene's nature (0038) colors each PARTICIPANT's mood, per role (audit E50).
 * The pre-E50 bug gave the BETRAYER the betrayed emotion while the victim's soul never moved:
 * the initiator of a betrayal is scheming (low-grade agitation); the PARTNER is the one betrayed.
 */
const OFFSCREEN_EMOTION: Record<SceneRole, Record<InteractionType, EmotionalEvent>> = {
  initiator: {
    alliance: "bond",
    bonding: "bond",
    showmance: "bond",
    gossip: "scheme",
    strategy: "scheme",
    conflict: "scheme",
    betrayal: "scheme", // the one doing the turning is plotting, not wounded (E50)
  },
  partner: {
    alliance: "bond",
    bonding: "bond",
    showmance: "bond",
    gossip: "scheme",
    strategy: "scheme",
    conflict: "scheme",
    betrayal: "betrayed", // the victim's soul finally moves (E50)
  },
};

export function offscreenEmotion(type: InteractionType, role: SceneRole = "initiator"): EmotionalEvent {
  return OFFSCREEN_EMOTION[role][type];
}

// PERSIST-2/BE-101: guard NaN → 0 before it reaches `soul.emotionalState`/`soul.volatility` — a
// persisted layer that must never degrade (I5). Finite inputs clamp exactly as before.

/**
 * 0124 — the DEEPER-evolution tunables (all magnitudes for the default-ON `ORWELL_SOUL_DEPTH` layer (`=0` opts out) live here).
 * Untouched unless the layer is on, so the 0041 single-scalar path stays byte-identical.
 */
const SOUL_DEPTH = {
  /** The neutral resting point for the `distress`/`confidence` axes (0.5 = neither felt). */
  axisBaseline: 0.5,
  /** How much a negative-valence event raises `distress` (blindside valence −0.6 ⇒ +0.6·gain). */
  distressGain: 0.6,
  /** How much a positive-valence event raises `confidence` (comp-win valence +0.45 ⇒ +0.45·gain). */
  confidenceGain: 0.6,
  /** Fraction of the gap each axis reverts toward its baseline on a `calm` beat (scaled by settleScale). */
  axisSettle: 0.25,
  /** How much harder `distress` drags a composed read than `confidence` lifts it (so "confident AND rattled" underperforms "purely confident"). */
  distressDrag: 1.5,
  /** Per-event temperament-drift magnitude (a betrayal nudges the effective disposition this far toward clash). */
  driftGain: 0.28,
  /** B32 (ORWELL_DRIFT_FIX): the negativity bias on the temperament accumulator - a hardening event gains x1.5, a softening one x0.75 (matches the memory ledger's grudgeMax > favorMax). */
  negativityClashMul: 1.5,
  negativityBondMul: 0.75,
  /** B32 (ORWELL_DRIFT_FIX): softening cannot push the temperament below this floor, so a run of routine good beats (bond / survived-vote / comp-win, which fire for most houseguests most weeks) cannot pin it at the bond limit where three real betrayals could never lift it back to clash. The measured #2104 finding: with a symmetric clamp the median drift sat at -1.0. */
  driftBondFloor: -0.7,
  /** Fraction the temperament drift reverts toward 0 (the true baseline) on a `calm` beat (× settleScale). */
  driftSettle: 0.2,
  /** Effective-disposition bands: |base+drift| past these reads clash/bond, else neutral (hysteresis). */
  clashBand: 0.5,
  bondBand: -0.5,
  /** Per-disposition settle multiplier (part C): clash lingers, bond shrugs it off, neutral unchanged. */
  settleOf: { clash: 0.6, bond: 1.4, neutral: 1.0 } as Record<Disposition, number>,
} as const;

const clampSigned = (v: number, m: number): number => (Number.isNaN(v) ? 0 : Math.max(-m, Math.min(m, v)));
const revertToward = (v: number, target: number, frac: number): number => v + (target - v) * frac;

/** 0124 — which way an event bends the temperament: + toward clash-paranoia, − toward bond-trust, 0 neutral. */
function driftOf(event: EmotionalEvent): number {
  switch (event) {
    case "blindside": case "betrayed": case "nominated": return +SOUL_DEPTH.driftGain;
    case "bond": case "survived-vote": case "comp-win":   return -SOUL_DEPTH.driftGain;
    default: return 0; // scheme / comp-loss / calm don't bend the strategic temperament
  }
}

/**
 * 0124 (part A) — the composed emotional read the behavior layer uses WHEN the independent axes are present.
 * `confidence` lifts and `distress` drags (harder, by `distressDrag`), so a houseguest who is confident AND
 * rattled reads WORSE than one who is purely confident. Absent axes ⇒ the plain `emotionalState` (the 0041
 * value), so with the layer off this is byte-identical. Bounded [0,1], 0.5 = calm (what 0006/0028 expect).
 */
export function composedEmotion(soul: Soul): number {
  if (soul.distress === undefined || soul.confidence === undefined) return soul.emotionalState;
  const lift = soul.confidence - SOUL_DEPTH.axisBaseline;
  const drag = (soul.distress - SOUL_DEPTH.axisBaseline) * SOUL_DEPTH.distressDrag;
  return clamp01(SOUL_DEPTH.axisBaseline + lift - drag);
}

/**
 * 0124 (part B) — the EFFECTIVE disposition = the static baseline bent by the soul's accumulated
 * `temperamentDrift`, banded back to clash/bond/neutral with hysteresis. A repeatedly-burned houseguest
 * hardens toward paranoia; a calm stretch reverts them toward who they really are. The static CHARACTER
 * disposition is NEVER changed (0007) — this is a pure READ over the drifting soul. No drift ⇒ the baseline.
 */
export function effectiveDisposition(baseline: Disposition, soul: Soul): Disposition {
  const drift = soul.temperamentDrift ?? 0;
  if (drift === 0) return baseline;
  const base = baseline === "clash" ? 1 : baseline === "bond" ? -1 : 0;
  const v = base + drift;
  if (v >= SOUL_DEPTH.clashBand) return "clash";
  if (v <= SOUL_DEPTH.bondBand) return "bond";
  return "neutral";
}

/** 0124 (part C) — a houseguest's disposition-derived settle multiplier (clash lingers, bond shrugs off). */
export function settleScaleOf(disposition: Disposition): number {
  return SOUL_DEPTH.settleOf[disposition];
}

/**
 * Evolve a soul's `emotionalState` + `volatility` from one live event, in place. Bounded,
 * mean-reverting toward the soul's emotional baseline. A more volatile soul swings harder.
 * Appends the new level to `emotionalHistory` so the trajectory persists and never degrades
 * (0007/0030).
 *
 * Audit E52: the state nudge now DELEGATES to the canonical 0028 `emotionalModifier` (one formula,
 * one tunables home — no dead parallel math), and an optional seeded `rng` adds ADR 0001's bounded
 * per-moment temperature roll (weighted by `emotional.swingTemperatureWeight`). Without an rng the
 * evolution is deterministic and byte-identical to the pre-E52 behavior — pure tests stay stable.
 */
export function evolveEmotion(
  soul: Soul,
  event: EmotionalEvent,
  c: TemperatureConstants = TEMPERATURE_CONSTANTS,
  rng?: RandomnessSource,
  opts: { soulDepth?: boolean; negativityBias?: boolean; driftScale?: number } = {},
): void {
  const { valence, arousal } = IMPACT[event];
  const k = c.emotional.volatilityScale;

  // emotionalState: nudge by valence (scaled by current volatility) + the bounded temperature
  // roll, then mean-revert toward the SOUL's own baseline — all via the canonical 0028 formula.
  const circumstance = valence * (0.5 + soul.volatility);
  const temperature = rng ? temperatureRoll(rng, c) * c.emotional.swingTemperatureWeight : 0;
  soul.emotionalState = clamp01(
    emotionalModifier(soul.emotionalState, circumstance, temperature, c, soul.emotionalBaseline),
  );

  // volatility: shocks raise it; calm/bonding settle it. Bounded. 0124 (part C): a disposition-derived
  // `settleScale` slows/speeds ONLY the SETTLING (negative arousal) — a clash soul's agitation lingers, a
  // bond soul shrugs it off; shocks (positive arousal) spike fully. Gated on `opts.soulDepth` so a save that
  // PERSISTED a `settleScale` (created flag-on) then runs flag-OFF is byte-identical to 0041 — the default-off
  // contract holds even across a flag flip (Greptile P1). Off / absent settleScale ⇒ ×1.
  const settleScale = opts.soulDepth && arousal < 0 ? (soul.settleScale ?? 1) : 1;
  soul.volatility = clamp01(soul.volatility + arousal * k * settleScale);

  // 0124 (parts A + B): when the deeper-evolution layer is on, move the INDEPENDENT affect axes and the
  // temperament drift. Skipped entirely (and the axis fields stay absent) unless `opts.soulDepth` — so the
  // single-scalar 0041 path above is untouched and byte-identical when off.
  if (opts.soulDepth) {
    const settle = soul.settleScale ?? 1;
    if (soul.distress === undefined) soul.distress = SOUL_DEPTH.axisBaseline;
    if (soul.confidence === undefined) soul.confidence = SOUL_DEPTH.axisBaseline;
    if (soul.temperamentDrift === undefined) soul.temperamentDrift = 0;
    if (event === "calm") {
      // a quiet stretch reverts every axis toward baseline (× settleScale — bond settles faster).
      soul.distress = clamp01(revertToward(soul.distress, SOUL_DEPTH.axisBaseline, SOUL_DEPTH.axisSettle * settle));
      soul.confidence = clamp01(revertToward(soul.confidence, SOUL_DEPTH.axisBaseline, SOUL_DEPTH.axisSettle * settle));
      soul.temperamentDrift = soul.temperamentDrift * (1 - SOUL_DEPTH.driftSettle * settle);
    } else {
      // distress rises on negative-valence events; confidence on positive — INDEPENDENTLY (both can climb).
      soul.distress = clamp01(soul.distress + Math.max(0, -valence) * SOUL_DEPTH.distressGain);
      soul.confidence = clamp01(soul.confidence + Math.max(0, valence) * SOUL_DEPTH.confidenceGain);
      let d = driftOf(event) * (opts.driftScale ?? 1);
      if (opts.negativityBias) d *= d > 0 ? SOUL_DEPTH.negativityClashMul : SOUL_DEPTH.negativityBondMul;
      soul.temperamentDrift = opts.negativityBias ? Math.max(SOUL_DEPTH.driftBondFloor, Math.min(1, soul.temperamentDrift + d)) : clampSigned(soul.temperamentDrift + d, 1);
    }
  }

  // arc: the trajectory of where the season has taken them (monotonic, never dropped).
  soul.emotionalHistory.push(soul.emotionalState);
}

/**
 * A short, NAME-FREE arc note for the soul's deepening narrative + vector recall (0024). Carries a
 * distinguishing keyword so a later `recall` can surface this specific inflection to keep the
 * houseguest's voice consistent with what the season did to them.
 */
export function arcNote(event: EmotionalEvent, week: number): string {
  switch (event) {
    case "blindside":      return `week ${week}: blindsided by an eviction — rattled, guarded now`;
    case "betrayed":       return `week ${week}: betrayed by someone they trusted — wary`;
    case "nominated":      return `week ${week}: put on the block — exposed, rattled going into the veto`;
    case "comp-loss":      return `week ${week}: lost a competition — frustrated`;
    case "scheme":         return `week ${week}: deep in off-screen scheming — restless`;
    case "calm":           return `week ${week}: a quiet stretch — steadier`;
    case "bond":           return `week ${week}: bonded with an ally off-screen — reassured`;
    case "survived-vote":  return `week ${week}: survived the block — emboldened`;
    case "comp-win":       return `week ${week}: won a competition — confident`;
  }
}
