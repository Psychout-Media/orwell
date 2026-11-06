import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { clamp01 } from "../domain/num";

/**
 * Feature 0110 — Vote deduction (process of elimination).
 *
 * Eviction votes are SECRET ballots (0047): the COUNT is public, the attribution is not. An evictee
 * cannot be handed the true tally — so they DEDUCE who moved against them from the public count, the
 * eligible voter pool, and their OWN reads (who they trusted "wouldn't", who they suspected). The
 * result is a BELIEF (0002) held with a confidence, and it CAN BE WRONG. The 0037/0014 jury grudge
 * folds on this belief (never on the true `votesToEvict`), which honors the secret ballot while keeping
 * jury management real:
 *   • a deducible defector earns the grudge;
 *   • an UNDEDUCIBLE secret vote earns none (secrecy honored);
 *   • a WRONG deduction misattributes it (dramatic irony).
 *
 * PURE + engine-only. No number, belief, or confidence ever crosses the wall (mandate #2/#3).
 */

export interface VoteDeductionConstants {
  /** How strongly a high threat-read pushes a pool member toward "they voted against me". */
  threatWeight: number;
  /** How strongly a low trust-read (lack of loyalty) pushes them toward "they voted against me". */
  trustWeight: number;
  /**
   * The bounded ambiguity term — a seeded wobble on the suspicion ranking. It re-orders NEAR-TIES only
   * (a clearly-suspected defector is never displaced), so an ambiguous vote can misattribute while a
   * forced one stays correct. Consumed on a DEDICATED sub-rng (never the shared streams).
   */
  ambiguityJitter: number;
  /** The base-score margin (at the cut line) that reads as a FULLY-constrained, high-confidence deduction. */
  confidenceMargin: number;
}

export const VOTE_DEDUCTION_CONSTANTS: VoteDeductionConstants = {
  threatWeight: 1.0,
  trustWeight: 1.0,
  ambiguityJitter: 0.35,
  confidenceMargin: 0.4,
};

/** The evictee's read of one pool member, as the deduction uses it. */
export interface DeductionRead {
  edge(from: EntityId, to: EntityId): { trust: number; threat: number };
}

export interface DeducedVoters {
  /** Who the evictee BELIEVES voted against them — the `count` most-suspected pool members. */
  believed: EntityId[];
  /** 0..1: how forced/unambiguous the arrangement is (1 = unanimous or fully-constrained). */
  confidence: number;
  /** Per pool member: whether the evictee believes they voted, and their raw suspicion (engine-only). */
  perVoter: Map<EntityId, { believed: boolean; suspicion: number }>;
}

/**
 * A deterministic numeric seed for the DEDICATED deduction sub-rng, from the evictee + week. Isolated
 * from the shared streams so the deduction's ambiguity wobble never perturbs the seeded comp/vote order
 * (and so the OFF path — which never calls this — stays byte-identical). FNV-1a over the key.
 */
export function deductionSeed(evictee: EntityId, week: number): number {
  let h = (2166136261 ^ week) >>> 0;
  const key = `${evictee}:votededuce`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deduce who the evictee believes voted to evict them, by process of elimination. NEVER reads the true
 * ballot — only the public `count`, the eligible `pool`, and the evictee's reads (`rel`).
 */
export function deduceEvictionVoters(
  evictee: EntityId,
  pool: readonly EntityId[],
  count: number,
  rel: DeductionRead,
  rng: RandomnessSource,
  c: VoteDeductionConstants = VOTE_DEDUCTION_CONSTANTS,
): DeducedVoters {
  const candidates = pool.filter((v) => v !== evictee);
  const n = Math.max(0, Math.min(count, candidates.length));

  // Suspicion: a high threat-read + a low trust-read (from the evictee TOWARD each pool member) reads as
  // "they moved against me". The seeded jitter wobbles only near-ties (ambiguity → possible misattribution).
  const scored = candidates
    .map((v) => {
      const e = rel.edge(evictee, v);
      const base = c.threatWeight * e.threat + c.trustWeight * (1 - e.trust);
      const jitter = (rng.next() - 0.5) * c.ambiguityJitter;
      return { v, base, ranked: base + jitter };
    })
    .sort((a, b) => b.ranked - a.ranked);

  const believed = scored.slice(0, n).map((s) => s.v);
  const believedSet = new Set(believed);
  const perVoter = new Map(scored.map((s) => [s.v, { believed: believedSet.has(s.v), suspicion: s.base }]));

  return { believed, confidence: deductionConfidence(scored.map((s) => s.base), n), perVoter };
}

/**
 * How CONFIDENT the deduction is, from the BASE (un-jittered) suspicion scores. A unanimous vote or an
 * empty field is fully constrained (1). Otherwise it is the normalized margin at the cut line: a big gap
 * between the last believed defector and the first spared houseguest ⇒ a forced, high-confidence read;
 * a small gap ⇒ an ambiguous, low-confidence one (the belief that can be wrong).
 */
export function deductionConfidence(
  basesDesc: readonly number[],
  count: number,
  c: VoteDeductionConstants = VOTE_DEDUCTION_CONSTANTS,
): number {
  if (count <= 0 || count >= basesDesc.length) return 1; // no defectors, or unanimous — fully constrained
  const margin = basesDesc[count - 1]! - basesDesc[count]!; // gap at the believed/spared boundary
  return clamp01(margin / c.confidenceMargin);
}
