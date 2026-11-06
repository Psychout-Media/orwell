/**
 * STATUS (0103 — reopened 2026-07-12; engine CORE built, runtime wiring deferred): this pure core and its unit
 * test are built, but nothing in the live game imports it yet — the adapter routing into the observation pathway and
 * the `momentPrompts` `editBayHint` field is the deferred part. (Noted in the #1939 doc-drift pass; an earlier pass
 * mislabelled this module "frozen" from the obsolete 2026-06-27 park.)
 *
 * Feature 0103 — edit-bay foreshadowing: the PURE fit/eligibility/hint core. NO I/O, NO Vault handle — it
 * is handed the ALREADY-READ, Vault-free SHAPE of the in-motion pathways (their motion status + the sealed
 * fit signals reduced to [0,1] reads + the PUBLIC observation to hang a hint on) and returns only a
 * re-ranking + a budget decision + a Vault-safe hint. It surfaces NOTHING itself: the adapter routes the
 * top eligible candidate into the EXISTING 0049/0002 anchored observation pathway + the `momentPrompts`
 * `editBayHint` field. The layer changes ONLY *which* Vault-safe observation the narrator is offered and
 * *whether* the weekly budget allows it this tick — it folds NO relationship weight, advances NO pathway,
 * and NEVER commits a seeded outcome (a foreshadowed campaign can still fail — the fake-out is a feature).
 *
 * Determinism: pure function of its inputs (no rng of its own — the SEEDED eligibility roll lives in the
 * adapter, on a DEDICATED side rng that never touches the shared society/competition/vote stream). Same
 * shapes ⇒ same fit ranking ⇒ same decisions.
 *
 * The Vault Wall is preserved by construction: `foreshadowFit` reads only reduced [0,1] signals and is
 * NEVER shown; a hint carries only the PUBLIC `observation` string + a tone word — never the pathway's
 * sealed premise, target, plan, or a number. It is strictly LESS than a 0092 drip (which eventually crosses
 * an anchored belief); a hint crosses only *that the camera lingered*.
 */
import { FORESHADOW } from "./foreshadowConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

/** The class of in-motion pathway a hint may foreshadow (all EXISTING organs). */
export type PathwayKind = "thread" | "drive" | "campaign" | "secret";

/** Lifecycle motion: only an `active`/in-flight pathway is foreshadowable — a `dormant` one is never nodded at. */
export type PathwayMotion = "dormant" | "active";

/**
 * The already-read, Vault-free SHAPE of one in-motion pathway (the adapter fills these; the sealed premise
 * NEVER enters). All signals are reduced to [0,1] — the pure module sees a re-ranking problem, never content.
 */
export interface InMotionPathway {
  /** The pathway's stable id (the seed-stable tiebreaker + the payoff link — engine-side only). */
  id: string;
  kind: PathwayKind;
  /** Only `active` is foreshadowable; a `dormant` (frozen) pathway has nothing in motion to edit footage of. */
  motion: PathwayMotion;
  /** PUBLIC surface ∈ [0,1] — is there an in-room observation to hang the hint on (0049/0077)? 0 ⇒ never foreshadowable. */
  observability: number;
  /** Relevance ∈ [0,1] — proximity + tension to the involved parties (both-way 0026 edges), for THIS player. */
  relevance: number;
  /** Lead-time ∈ [0,1] — a pathway 1-2 weeks from its likely payoff scores ~1; just-fired / stale ~0. */
  leadTime: number;
  /** Already-hinted ∈ [0,1] — how recently this pathway was foreshadowed (penalizes a re-nag). */
  alreadyHinted: number;
  /** The Vault-FREE public observation the hint hangs on (co-presence text) — NEVER the premise. Handed in. */
  observation: string;
}

/** A ranked foreshadow candidate: the input + its computed (sealed) fit. */
export interface RankedPathway extends InMotionPathway {
  fit: number;
}

/**
 * The sealed foreshadow fit of one in-motion pathway toward the player ∈ [0,1] — "how worth nodding at, for
 * THIS player, now". relevance + observability + leadTime − already-hinted (each weighted; clamped). NEVER
 * shown — it only re-ranks which in-motion pathway the show nods at. Pure.
 */
export function foreshadowFit(p: Pick<InMotionPathway, "relevance" | "observability" | "leadTime" | "alreadyHinted">): number {
  const C = FORESHADOW;
  return clamp01(
    C.relevanceWeight * clamp01(p.relevance)
    + C.observabilityWeight * clamp01(p.observability)
    + C.leadTimeWeight * clamp01(p.leadTime)
    - C.alreadyHintedPenalty * clamp01(p.alreadyHinted),
  );
}

/**
 * Seed-stable ranking of foreshadowable pathways, best-fit first. DROPS any pathway that is not in motion
 * (`dormant`), that has no public surface to hang a hint on (`observability` below the floor — the show
 * never invents an observation), or whose fit is below the relevance floor. Sorts descending by fit with
 * the id as the deterministic tiebreaker (a pure function of the inputs — never insertion order, never an
 * rng). The eligibility roll on the TOP candidate lives in the adapter on a dedicated side rng. Pure.
 */
export function rankForeshadowCandidates(pathways: readonly InMotionPathway[]): RankedPathway[] {
  return pathways
    .filter((p) => p.motion === "active" && p.observability >= FORESHADOW.observabilityFloor)
    .map((p) => ({ ...p, fit: foreshadowFit(p) }))
    .filter((p) => p.fit >= FORESHADOW.fitFloor)
    .sort((a, b) => (b.fit - a.fit) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The sealed per-week hint-budget state the foreshadow pass reads (persisted across a restart, never shown). */
export interface WeekBudgetState {
  /** The week the counter below is FOR (a new week resets the count — the cadence is per-week). */
  week: number;
  /** How many hints have already surfaced this week. */
  spentThisWeek: number;
  /** The live week (so a stale counter from a prior week is treated as 0 spent). */
  currentWeek: number;
  /** How many hints have surfaced across the whole season so far (the season cap binds this). */
  spentThisSeason: number;
}

/** The budget decision for THIS tick: whether the weekly + season ceilings still allow a hint. */
export interface BudgetDecision {
  /** True ⇒ neither the weekly nor the season ceiling is spent; a ripe candidate MAY nod this tick. */
  allowed: boolean;
  /** The count of hints already spent in the CURRENT week (0 when the stored counter is from a prior week). */
  spent: number;
  /** True once the weekly TARGET band's floor is reached (telemetry — the cadence is in its band). */
  atTargetMin: boolean;
}

/**
 * The weekly + season hint-budget gate (the pace). A NEW week resets the spent count to 0 (the cadence is
 * per-week); the HARD weekly ceiling (`maxHintsPerWeek`) and the HARD season cap (`maxHintsPerSeason`) are
 * the firehose stops. Pure.
 */
export function hintBudget(state: WeekBudgetState): BudgetDecision {
  const C = FORESHADOW;
  const spent = state.week === state.currentWeek ? Math.max(0, state.spentThisWeek) : 0;
  const weeklyOk = spent < C.maxHintsPerWeek;
  const seasonOk = Math.max(0, state.spentThisSeason) < C.maxHintsPerSeason;
  return { allowed: weeklyOk && seasonOk, spent, atTargetMin: spent >= C.weeklyTargetMin };
}

/**
 * The Vault-SAFE hint handed to the narrator (`momentPrompts.editBayHint`) + recorded as the player's own
 * observation. It carries ONLY the PUBLIC observation + a "building" tone + the pathway id (engine-side, for
 * the payoff link) — NEVER the sealed premise, target, plan, or a number. `pathwayId` is NOT surfaced.
 */
export interface EditBayHint {
  /** The Vault-free public observation the edit points at (the lingering camera / clipped aside). */
  observation: string;
  /** The suggestive "something's building" tone — never declarative (the show nods, it never states). */
  tone: string;
  /** ENGINE-SIDE ONLY — the in-motion pathway this foreshadows, so a later payoff can reference the nod.
   *  NEVER placed on any player/admin surface (the adapter strips it from `editBayHint` before narration). */
  pathwayId: string;
}

/**
 * Build the Vault-safe hint for a ranked candidate: it hangs on the candidate's ALREADY-DERIVED public
 * observation (the module never invents one) + the tone word. It carries NO premise, NO number, NO
 * committed outcome — and it mutates nothing (it returns a value; the layer folds nothing). Pure.
 */
export function buildHint(p: Pick<RankedPathway, "id" | "observation">): EditBayHint {
  return { observation: p.observation, tone: FORESHADOW.toneWord, pathwayId: p.id };
}

/**
 * Map a pathway's active age / horizon (in weeks-until-likely-payoff) to the lead-time term ∈ [0,1]: a
 * pathway ~1-2 weeks out edits best; one about to pay off this tick (0) or long off (≥ window) edits worst.
 * Reuses the thread's `active` age / a campaign's horizon the adapter already tracks. Pure.
 */
export function leadTimeFromWeeksOut(weeksOut: number, window = 3): number {
  const w = Math.max(0, weeksOut);
  if (w >= window) return 0;         // stale / too far out — the nod would not correlate with a payoff
  // Peak at ~1 week out, tapering to 0 at 0 (about to fire — no lead time) and at `window` (too far).
  return clamp01(1 - Math.abs(w - 1) / window);
}
