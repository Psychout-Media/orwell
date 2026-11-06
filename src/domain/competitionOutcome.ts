import type { EntityId } from "./ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { TEMPERATURE_CONSTANTS } from "./temperatureConstants";
import type { TemperatureConstants } from "./temperatureConstants";
import { clamp01Raw as clamp01 } from "./num";

/**
 * Competition resolution: outcomes are earned, never story convenience. A score
 * is the relevant stat (vs. the competition type) + a per-moment temperature roll
 * + a soul-sourced emotional modifier (NO Luck stat) + the declared intent + a hidden
 * REST deficit (ADR 0006: staying up late before a comp dulls performance). The
 * engine never special-cases the player. Deterministic under a fixed seed.
 * Weights are tunable config (the exact math is an open decision, spec §16.2).
 */
export type CompetitionType = "endurance" | "physical" | "puzzle" | "quiz" | "memory" | "mental" | "social";
export type Intent = "compete" | "throw" | "play-safe";

export interface Competitor {
  id: EntityId;
  stats: { physical: number; mental: number; social: number };
  /** 0..1 from the dynamic soul; 0.5 = baseline. A rattled houseguest competes differently. */
  emotionalState?: number;
  /**
   * The hidden REST deficit (0..1) carried into this comp from staying up late the night before
   * (ADR 0006). 0 = rested — the DEFAULT, which leaves the score BYTE-IDENTICAL to the pre-feature
   * model (the seeded calibration spine is unmoved); 1 = ran clear into late-night. Bounded, never
   * protective, and never a number the player sees — only the worse result.
   */
  restPenalty?: number;
  /**
   * Feature 0098 (confidence-calibrated reads) — OPT-IN, DEFAULT `1` (= byte-identical). The player's
   * hidden CONVICTION (0..1) in the belief this action is grounded in: 1 = acts on what they KNOW
   * (baseline width), → 0 = near-blind faith (the widest, capped swing). Lower conviction WIDENS this
   * competitor's seeded temperature span SYMMETRICALLY about its unchanged center — fatter tails BOTH
   * ways (a bold correct read pays off bigger, blind faith craters harder) — and the same seeded roll
   * then falls where it falls. It NEVER shifts the mean and NEVER aims the result (anti-sycophancy): the
   * engine does not read whether the belief is TRUE, only how sure the player is. Never a number the
   * player OR admin sees — only the bigger swing. Derived engine-side from the belief's own hidden
   * `confidence` (0002). NO caller passes it today: the live adapter pass-through is deliberately
   * OWNER-GATED (the 0098 spec's standing-principle caveat), so the calibration spine is byte-identical.
   */
  conviction?: number;
}

/** Local [0,1] clamp (kept module-local so `src/domain` stays I/O- and import-free). */

/** The governing aptitude per competition type — exported so the 0042 library can pin to it. */
export const RELEVANT: Record<CompetitionType, "physical" | "mental" | "social"> = {
  endurance: "physical", physical: "physical",
  puzzle: "mental", quiz: "mental", memory: "mental", mental: "mental",
  social: "social",
};

/**
 * Calibrated so a clear stat favorite wins a strong majority but loses a real
 * minority. The numbers now live in the single tunable module (0028); this is a
 * re-export so existing importers keep working.
 */
export const OUTCOME_WEIGHTS = TEMPERATURE_CONSTANTS.outcome;

export interface CompetitionResult {
  winner: EntityId;
  scores: Record<EntityId, number>;
  temperature: Record<EntityId, number>;
}

/** Declared before a competition; immutable once the result is given. */
export class CompetitionIntents {
  private locked = false;
  private readonly map = new Map<EntityId, Intent>();

  declare(id: EntityId, intent: Intent): void {
    if (this.locked) throw new Error("competition intent is immutable after the result is given");
    this.map.set(id, intent);
  }

  lock(): void {
    this.locked = true;
  }

  intentOf(id: EntityId): Intent {
    return this.map.get(id) ?? "compete";
  }
}

export function resolveCompetition(
  competitors: Competitor[],
  type: CompetitionType,
  intents: CompetitionIntents,
  rng: RandomnessSource,
  /** Tunable temperature/outcome constants (0028); defaults to the single module. */
  constants: TemperatureConstants = TEMPERATURE_CONSTANTS,
  /**
   * Feature 0127 — the competition's SECONDARY aptitude for a genuine HYBRID comp (e.g. a physical
   * challenge with a puzzle element). When present, the stat base is a weighted blend of the primary
   * (`RELEVANT[type]`) and this secondary — the primary still dominates (`1 − w`), the secondary tilts
   * (`w = constants.outcome.mixedSecondaryWeight`). Undefined ⇒ the pure single stat ⇒ BYTE-IDENTICAL.
   * The engine still decides on stats (anti-sycophancy); a hybrid just rewards a well-rounded houseguest.
   */
  secondaryStat?: "physical" | "mental" | "social",
): CompetitionResult {
  // Audit C5: fail LOUDLY on malformed fields. An empty field used to die with a bare
  // TypeError, and a NaN stat silently crowned competitors[0] (every NaN comparison is
  // false, so the initial candidate never lost) — an anti-sycophancy hole: a data bug
  // could quietly fix a competition. Outcomes are earned; malformed input is a refusal.
  if (competitors.length === 0) throw new Error("resolveCompetition: empty competitor field");
  for (const c of competitors) {
    for (const key of ["physical", "mental", "social"] as const) {
      if (!Number.isFinite(c.stats[key])) {
        throw new Error(`resolveCompetition: non-finite ${key} stat for a competitor`);
      }
    }
    if (c.emotionalState !== undefined && !Number.isFinite(c.emotionalState)) {
      throw new Error("resolveCompetition: non-finite emotionalState for a competitor");
    }
    if (c.restPenalty !== undefined && !Number.isFinite(c.restPenalty)) {
      throw new Error("resolveCompetition: non-finite restPenalty for a competitor");
    }
    if (c.conviction !== undefined && !Number.isFinite(c.conviction)) {
      throw new Error("resolveCompetition: non-finite conviction for a competitor");
    }
  }

  const stat = RELEVANT[type];
  const w = constants.outcome;
  const span = constants.bound.max - constants.bound.min;

  // One bounded temperature draw per competitor, in array order (seed-reproducible).
  const temperature: Record<EntityId, number> = {};
  for (const c of competitors) temperature[c.id] = constants.bound.min + rng.next() * span;

  const scores: Record<EntityId, number> = {};
  for (const c of competitors) {
    // 0127: a hybrid comp blends the primary stat with a secondary aptitude (the primary still dominates).
    // No secondary ⇒ the pure single stat ⇒ byte-identical. The blend never changes the temperature/emotion/
    // intent/rest terms — only which combined aptitude the stat base rewards.
    const effectiveStat =
      secondaryStat && secondaryStat !== stat
        ? c.stats[stat] * (1 - w.mixedSecondaryWeight) + c.stats[secondaryStat] * w.mixedSecondaryWeight
        : c.stats[stat];
    const base = effectiveStat * w.stat;
    // Feature 0098: widen ONLY this competitor's seeded temperature span SYMMETRICALLY about its
    // unchanged center (0), by a bounded inverse-conviction factor clamped to the hard ceiling. The RAW
    // drawn `temperature` map is untouched (the seeded draw is unchanged) — only the SCORE's temperature
    // contribution widens, so E[temp]=0 keeps the mean unmoved (mean-preserving) while the variance rises.
    // conviction 1/undefined ⇒ factor 1 ⇒ BYTE-IDENTICAL. The engine never reads whether the belief is
    // true; it only scales variance by how sure the player is (anti-sycophancy — no thumb on the scale).
    const convictionFactor = Math.min(
      1 + w.convictionVarianceGain * (1 - clamp01(c.conviction ?? 1)),
      w.convictionVarianceCap,
    );
    const temp = temperature[c.id]! * w.temperature * convictionFactor;
    const emo = ((c.emotionalState ?? 0.5) - 0.5) * 2 * w.emotion;
    const intent = intents.intentOf(c.id);
    const intentAdj =
      intent === "throw" ? -w.throwPenalty
      : intent === "play-safe" ? -w.playSafePenalty
      : 0;
    // The hidden, bounded sleep cost (ADR 0006). 0 by default ⇒ this term vanishes and the score is
    // byte-identical to the pre-feature model; a tired houseguest competes worse, and the engine
    // never protects them (a tired favorite can lose). No rng here — the deficit was decided already.
    const rest = -(c.restPenalty ?? 0) * w.sleepPenalty;
    scores[c.id] = base + temp + emo + intentAdj + rest;
  }

  let winner = competitors[0]!.id;
  for (const c of competitors) if (scores[c.id]! > scores[winner]!) winner = c.id;

  intents.lock(); // the result is now given — intents can no longer change
  return { winner, scores, temperature };
}

/**
 * The VISIBLE elimination order of an ALREADY-RESOLVED competition (the 0006 staged-rounds
 * evolution, PR #395) — PRESENTATION ONLY, derived purely from the single roll's scores.
 *
 * The staged endurance presentation narrows the field one houseguest at a time until the crowned
 * winner stands alone. This derives that drop order from the SAME `scores` `resolveCompetition`
 * already computed: the LOWEST score drops first, ascending up to (but excluding) the winner, who
 * survives every round by construction. It consumes NO randomness and reads NO new state — it is a
 * deterministic RE-TELLING of the one calibrated roll, so the staged presentation can NEVER perturb
 * the winner OR any downstream seeded roll. This is what makes the staged comp full-trajectory
 * outcome-neutral with the pre-staging single-shot model (the jury calibration band depends on it).
 *
 * `field` is the competitors' ids in their original (resolution) order; `result` is that roll's
 * output. The returned array lists every NON-winner, earliest drop first. Score ties break by the
 * original field order (stable), so the order is byte-stable for a given result.
 */
export function eliminationOrder(field: EntityId[], result: CompetitionResult): EntityId[] {
  const indexOf = new Map(field.map((id, i) => [id, i] as const));
  return field
    .filter((id) => id !== result.winner)
    .sort((a, b) => {
      const d = result.scores[a]! - result.scores[b]!;
      return d !== 0 ? d : indexOf.get(a)! - indexOf.get(b)!;
    });
}
