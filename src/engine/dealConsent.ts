import type { DealKind } from "../domain/deal";
import { DEAL_CONSENT, type DealRefusalReason } from "./dealConsentConstants";

/**
 * NPC deal CONSENT (anti-sycophancy; the engine decides outcomes, the narrator only voices them). Before a player-proposed deal is recorded the NPC decides, from
 * THEIR OWN perspective, whether it is worth agreeing to. A pure, deterministic, bounded function of the NPC's reads of the player — no rng (the adapter supplies one
 * seeded `jitter`), no I/O, no Vault handle. The reason is a coarse, Vault-free category the narrator can voice in fiction; the score itself never crosses the seam.
 */

/** Everything the NPC weighs. All read from EXISTING engine state by the adapter; none of it is new state. */
export interface DealConsentInputs {
  kind: DealKind;
  /** The NPC's trust in the player (relationship edge NPC->player), 0..1. */
  trust: number;
  /** The NPC's affinity (liking) for the player, 0..1. */
  affinity: number;
  /** The NPC's read of the player as a threat, 0..1. */
  threat: number;
  /** Residual grudge from NPC memory toward the player (0..grudgeMax). 0 when the memory layer is off. */
  grudge: number;
  /** Residual remembered favor toward the player (0..favorMax). 0 when the memory layer is off. */
  favor: number;
  /** The NPC's belief that the player is targeting them (belief-store tilt, 0..max). 0 when the belief store is off. */
  targetsMe: number;
  /** The per-decision seeded jitter in [-DEAL_CONSENT.jitter, +DEAL_CONSENT.jitter] (the adapter derives it from a dedicated rng; never the shared season rng). */
  jitter: number;
  /** B55: who the PROMISOR is for an active kind (comp-throw / veto-save). `offer` = the player promises (to the NPC it is a favor, cheap); `ask` or absent = the NPC is asked to promise (priced as before). */
  direction?: "offer" | "ask";
  /** ORW-87: the NPC's own drive/campaign push AGAINST the player (>= 0, ~0..0.2). Absent/0 => byte-identical. */
  opposed?: number;
  /** B31 (ORWELL_MOOD_DEAL): a signed shift from the NPC's visible mood (tells). Absent/0 => byte-identical. */
  mood?: number;
}

export interface DealConsentDecision { accept: boolean; reason?: DealRefusalReason }

const num = (x: number): number => (Number.isFinite(x) ? x : 0);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, num(x)));

/** The bounded drags (>= 0) each negative signal puts on the NPC's willingness, measured from the neutral baseline. */
function drags(i: DealConsentInputs): Record<"distrust" | "threat" | "targeted" | "grudge" | "opposed", number> {
  const { weight: w, reference: r } = DEAL_CONSENT;
  return {
    distrust: w.trust * Math.max(0, r.trust - clamp01(i.trust)) + w.affinity * Math.max(0, r.affinity - clamp01(i.affinity)),
    threat: w.threat * Math.max(0, clamp01(i.threat) - r.threat),
    targeted: w.targetsMe * Math.max(0, num(i.targetsMe)),
    grudge: w.grudge * Math.max(0, num(i.grudge)),
    opposed: w.opposed * Math.max(0, num(i.opposed ?? 0)),
  };
}

/** The willingness score (higher = more willing; 0 = a typical newcomer's read). Bounded by construction: every term is a clamped signal times a fixed weight. Excludes the jitter. */
export function dealWillingness(i: DealConsentInputs): number {
  const { weight: w, reference: r } = DEAL_CONSENT;
  const favor = Math.min(DEAL_CONSENT.favorCeiling, w.favor * Math.max(0, num(i.favor)));
  return w.trust * (clamp01(i.trust) - r.trust) + w.affinity * (clamp01(i.affinity) - r.affinity) - w.threat * (clamp01(i.threat) - r.threat)
    - w.grudge * Math.max(0, num(i.grudge)) - w.targetsMe * Math.max(0, num(i.targetsMe)) - w.opposed * Math.max(0, num(i.opposed ?? 0)) + favor + num(i.mood ?? 0);
}

/**
 * Does the NPC agree? `accept` when `willingness + jitter >= cost(kind)`. On a refusal the reason is the NPC's most salient motive: the largest MATERIAL drag
 * (distrust / threat / targeted / grudge); and `cost` when nothing about the player is what sank it (the ask simply costs too much for where the two stand).
 */
export function decideDealConsent(i: DealConsentInputs): DealConsentDecision {
  const active = i.kind === "comp-throw" || i.kind === "veto-save";
  const cost = active && i.direction === "offer" ? DEAL_CONSENT.offerCost : (DEAL_CONSENT.cost[i.kind] ?? DEAL_CONSENT.cost["veto-save"]);
  const jitter = Math.max(-DEAL_CONSENT.jitter, Math.min(DEAL_CONSENT.jitter, num(i.jitter)));
  const score = dealWillingness(i) + jitter;
  if (score >= cost) return { accept: true };
  const d = drags(i);
  const order: Array<keyof typeof d> = ["opposed", "targeted", "grudge", "threat", "distrust"]; // ties: the more specific / more personal motive first
  let top: keyof typeof d = "distrust";
  let topVal = -1;
  for (const k of order) if (d[k] > topVal) { top = k; topVal = d[k]; }
  // Would the NPC have said yes if none of the player's drags applied? If so a drag sank it; if not, the ask is just dear — unless a drag is still material.
  const sum = d.distrust + d.threat + d.targeted + d.grudge + d.opposed;
  const wouldHaveAccepted = score + sum >= cost;
  if (wouldHaveAccepted || topVal >= DEAL_CONSENT.materialDrag) return { accept: false, reason: top };
  return { accept: false, reason: "cost" };
}
