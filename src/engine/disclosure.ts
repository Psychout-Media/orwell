import type { EntityId } from "../domain/ids";
import { clampGuarded } from "../domain/num";

/**
 * B10 / B11 slice 1 (design `info-copresence-design.md` S1) - the HOLDER'S CHOICE. When a holder and a listener share a room and the holder owns a fact the listener lacks, the engine draws ONE
 * closed-set decision: `share` (intentional, truthful or spun), `slip` (unintentional) or `hold`. Pure and deterministic given the supplied `roll` (0..1) - no rng handle, no I/O, no Vault. The
 * caller owns the dedicated per-(holder, listener, week, beat) rng and passes ONE draw; every term is bounded so no input can force or forbid a branch outright except the trust gate on risky facts.
 * Wiring (the scene tick, the told-to set, the receipt path) is a later slice behind a flag default OFF; this module changes nothing by itself.
 */
export type Disclosure = "share" | "slip" | "hold";
export type Spin = "truthful" | "spun" | "lie";

export interface DisclosureInput {
  /** 0..1 - what the holder gains by telling (a want/campaign/drive toward the subject, reciprocity owed, bond-building). */
  motive: number;
  /** 0..1 - the holder's trust in the listener. */
  holderTrustsListener: number;
  /** 0..1 - the listener's trust in the holder (a stranger is not believed). */
  listenerTrustsHolder: number;
  /** 0..1 - how much telling costs the holder if it travels (their own secret ~1, a third party's ~0.2). */
  risk: number;
  /** Awake others in earshot besides holder and listener (sleepers excluded by the caller). */
  audience: number;
  /** 0..1 personality: how guarded/leaky the holder is. */
  leakiness: number;
  cunning: number;
  /** 0..1 - shaken emotional state (raises slip). */
  rattled: number;
  /** 0..1 - a recorded press from the listener, never wording-derived. */
  pressure: number;
  /** One uniform draw in [0,1) from the caller's dedicated rng. */
  roll: number;
}

export const DISCLOSURE = {
  /** Below this holder->listener trust a RISKY fact (risk >= riskGate) is never shared deliberately. */
  trustGate: 0.35,
  riskGate: 0.6,
  /** Each extra person in earshot lowers deliberate sharing by this, floored at audienceFloor of the base. */
  audiencePenalty: 0.12,
  audienceFloor: 0.25,
  /** Max probabilities - nothing is certain. */
  maxShare: 0.85,
  maxSlip: 0.3,
  /** Cunning at or above this lets a share be spun; at or above lieAt it may be a lie. */
  spinAt: 0.55,
  lieAt: 0.8,
} as const;

const clamp = (x: number, lo = 0, hi = 1): number => clampGuarded(x, lo, hi);

/** The two bounded probabilities the roll is compared against - exposed so a test can prove monotonicity without sampling. */
export function disclosureOdds(i: Omit<DisclosureInput, "roll">): { share: number; slip: number } {
  const trust = clamp(i.holderTrustsListener);
  const risky = clamp(i.risk) >= DISCLOSURE.riskGate;
  // Deliberate sharing: motive and mutual trust push it up, risk and a crowd push it down. A risky fact to a near-stranger is never shared on purpose.
  const gated = risky && trust < DISCLOSURE.trustGate;
  const crowd = Math.max(DISCLOSURE.audienceFloor, 1 - DISCLOSURE.audiencePenalty * Math.max(0, i.audience));
  const base = 0.55 * clamp(i.motive) + 0.25 * trust + 0.15 * clamp(i.listenerTrustsHolder) + 0.2 * clamp(i.pressure) - 0.4 * clamp(i.risk);
  const share = gated ? 0 : clamp(base * crowd, 0, DISCLOSURE.maxShare);
  // Slipping: a leaky or rattled holder lets it out unintentionally - bounded, and independent of motive and of the trust gate.
  const slip = clamp(0.2 * clamp(i.leakiness) + 0.1 * clamp(i.rattled) + 0.05 * clamp(i.pressure), 0, DISCLOSURE.maxSlip);
  return { share, slip };
}

/** share if roll < P(share); else slip if the next band hits; else hold. Deterministic in `roll`. */
export function disclosureDecision(i: DisclosureInput): { decision: Disclosure; spin?: Spin } {
  const { share, slip } = disclosureOdds(i);
  const r = clamp(i.roll, 0, 0.999999);
  if (r < share) {
    const c = clamp(i.cunning);
    const spin: Spin = c >= DISCLOSURE.lieAt ? "lie" : c >= DISCLOSURE.spinAt ? "spun" : "truthful";
    return { decision: "share", spin };
  }
  if (r < share + slip) return { decision: "slip" };
  return { decision: "hold" };
}

export interface HeldFact { factId: string; motive: number; risk: number; subject?: EntityId }

/** Top-K held facts by motive for one (holder, listener) scene (ASSUMED K=2, pending Ryne) - stable on ties by factId so the pick never depends on iteration order. */
export function topHeldFacts(facts: readonly HeldFact[], k = 2): HeldFact[] {
  return [...facts].sort((a, b) => b.motive - a.motive || (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0)).slice(0, Math.max(0, k));
}
