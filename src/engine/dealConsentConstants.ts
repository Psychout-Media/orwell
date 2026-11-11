import type { DealKind } from "../domain/deal";

/**
 * NPC deal CONSENT - the single tunable module (B59: no magic numbers at the call sites). Every number `decideDealConsent` reads lives here.
 *
 * The model: a bounded WILLINGNESS score is compared with the ASK'S COST. 0 is "a typical newcomer's read of the player": the reference edge below is the
 * MEASURED start-of-season mean (12 seeds x 15 houseguests: trust 0.24, affinity 0.25, threat 0.31, sd ~0.1 - a fresh houseguest already sizes the newcomer up as a
 * mild threat). The NPC agrees when `willingness + jitter >= cost`. Costs are calibrated against that start-of-season spread so that:
 *   - a typical stranger accepts the cheap asks (safety / vote / target-other / final-two) at EVERY point of the jitter band, and ~80-90% of the opening cast does
 *     (the default game is not made harder; the odd NPC who distrusts the player still says no);
 *   - the active-obligation asks (comp-throw / veto-save) need a real ally (they cost the NPC a competition or a veto);
 *   - an NPC who distrusts, fears, holds a grudge against, or believes they are targeted by the player says no.
 */
export const DEAL_CONSENT = {
  /** The reference ("typical newcomer") edge every signal is measured from. */
  reference: { trust: 0.25, affinity: 0.25, threat: 0.3 },
  /** How much each signal moves the willingness score. */
  weight: {
    trust: 0.55,       // the NPC's sentiment-trust in the player: the main lever
    affinity: 0.25,    // liking
    threat: 0.45,      // the NPC's read of the player as a THREAT (a drag)
    grudge: 2.0,       // a remembered betrayal (npcMemory grudge, max 0.15) - a drag
    favor: 2.0,        // a remembered favor (npcMemory favor, max 0.06) - a bonus
    targetsMe: 2.0,    // the NPC's BELIEF that the player is targeting them (belief store, max 0.18) - a drag
  },
  /** Cap on the favor bonus so a remembered kindness can tip a marginal NPC but never buy an ask on its own. */
  favorCeiling: 0.12,
  /** What the ask costs the NPC: a defensive promise is cheap; throwing a comp or burning a veto is not. Ordered cheap -> dear. */
  cost: {
    "safety": -0.12,
    "vote": -0.09,
    "target-other": -0.09,
    "final-two": -0.07,
    "protect-third": -0.09, // 0142: swearing to spare a third houseguest costs like a defensive promise
    "comp-throw": 0.08,
    "veto-save": 0.15,
  } as Record<DealKind, number>,
  /** B55: what an OFFER by the player costs the NPC (the player is the promisor, so the cost is the player's; to the NPC it is a favor, priced like a defensive promise). Used for the active kinds only. */
  offerCost: -0.09,
  /** Half-width of the seeded per-decision jitter: a marginal NPC can wobble, a clear one never flips. */
  jitter: 0.03,
  /** A single drag at/above this is "material" enough to be named as THE reason even when the ask was dear anyway. */
  materialDrag: 0.06,
} as const;

/** Vault-free, in-fiction reason categories the narrator voices. Closed set. */
export type DealRefusalReason = "distrust" | "threat" | "targeted" | "grudge" | "cost";

/** The narratable line per reason (no numbers, no Vault: how the houseguest would carry themselves, never why in terms of a hidden score). */
export const DEAL_REFUSAL_LINE: Record<DealRefusalReason, string> = {
  distrust: "doesn't trust you enough yet to shake on this",
  threat: "sees you as too big a threat to tie themselves to",
  targeted: "believes you are already coming after them",
  grudge: "is still holding a grudge over how you have treated them",
  cost: "this ask costs them too much for where the two of you stand",
};
