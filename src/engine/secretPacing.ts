/**
 * Feature 0092 — secret-pacing drip: the PURE pacing/eligibility core. NO I/O, NO Vault handle — it is
 * handed the ALREADY-READ relationship edges (both ways) + the threads' sealed lifecycle status, and it
 * returns only a re-ranking + a budget decision. It surfaces NOTHING itself: the adapter routes the top
 * eligible candidate into 0060's EXISTING anchored surface-to-player path (gossip / `surfaceInformationTo`
 * / the 0075 confidant slip). The drip changes ONLY *which* already-Wall-safe secret 0060 picks and
 * *whether* the weekly budget allows it — never the crossing odds, never the content, never a number.
 *
 * Determinism: this module is a pure function of its inputs (no rng of its own — the SEEDED eligibility
 * roll lives in the adapter, on a DEDICATED side rng that never touches the shared society/competition/
 * vote stream). Same edges + same lifecycle ⇒ same ripeness ranking ⇒ same drip decisions (§"determinism").
 *
 * The Vault Wall is preserved by construction: ripeness reads only the engine's OWN relationship reads
 * and the thread's sealed status — it is NEVER shown; only a re-ranking of 0060's surface decision
 * crosses, and that crossing is the unchanged anchored belief/paraphrase 0060 already produces (§7).
 */
import type { EntityId } from "../domain/ids";
import type { EdgeSignals } from "./relationshipConstants";
import { SECRET_PACING } from "./secretPacingConstants";
import { clamp01Raw as clamp01 } from "../domain/num";

/** Which 0060 pathway a ripe drip prefers (the channel its ripeness leans on). Both are EXISTING organs. */
export type DripChannel = "confidant" | "gossip";

/**
 * The already-read signals for one player-bound sealed secret (the adapter fills these; all Vault-hidden).
 * `proximity` / `tension` are derived from the BOTH-WAY player↔source relationship edges; `recency` from
 * the thread's `active` age; `alreadyTold` from the 0075 disclosure / 0060 surfaced state. None is shown.
 */
export interface PlayerBoundThread {
  /** The thread's stable id (the seed-stable tiebreaker for the ranking). */
  id: string;
  /** The source houseguest the secret belongs to. */
  sourceId: EntityId;
  /** Closeness ∈ [0,1] — the mutual player↔source bond (a confidant slips; an ally lets something show). */
  proximity: number;
  /** Friction ∈ [0,1] — high threat / low affinity in either direction (you're circling / clashing). */
  tension: number;
  /** Freshness ∈ [0,1] — a thread freshly-active scores ~1, one active weeks ago decays toward 0. */
  recency: number;
  /** 0..1 — how much the player has ALREADY caught wind of this secret (penalizes re-spam). */
  alreadyTold: number;
}

/** A ranked drip candidate: the input + its computed (sealed) ripeness + its preferred 0060 channel. */
export interface RankedThread extends PlayerBoundThread {
  ripeness: number;
  /** Proximity-ripe ⇒ the confidant channel (a close source TELLS); tension-ripe ⇒ gossip (a third party). */
  channel: DripChannel;
}

/**
 * The sealed ripeness of one secret toward the player ∈ [0,1] — "how ready is this to edge toward this
 * player now". proximity + tension + recency − already-told (each weighted; clamped). NEVER shown — it
 * only re-ranks which thread 0060 considers for surface-to-player. Pure.
 */
export function ripeness(input: Pick<PlayerBoundThread, "proximity" | "tension" | "recency" | "alreadyTold">): number {
  const C = SECRET_PACING;
  return clamp01(
    C.proximityWeight * clamp01(input.proximity)
    + C.tensionWeight * clamp01(input.tension)
    + C.recencyWeight * clamp01(input.recency)
    - C.alreadyToldPenalty * clamp01(input.alreadyTold),
  );
}

/**
 * Map the active age (in weeks since the thread last changed lifecycle) to the recency term ∈ [0,1]:
 * full this week, decaying linearly to 0 at `recencyDecayWeeks`. A hot secret is more likely to slip than
 * a stale one (reuses the thread's `active` age 0060 already tracks). Pure.
 */
export function recencyFromAge(weeksActive: number): number {
  const span = SECRET_PACING.recencyDecayWeeks;
  if (span <= 0) return 0;
  return clamp01(1 - Math.max(0, weeksActive) / span);
}

/**
 * The preferred 0060 channel for a candidate: a CLOSE source is more likely to TELL the player (the 0075
 * confidant slip); a source the player is at FRICTION with arrives via a third-party gossip chain. Decided
 * by which signal dominates — proximity ⇒ confidant, else gossip. Pure.
 */
export function channelFor(t: Pick<PlayerBoundThread, "proximity" | "tension">): DripChannel {
  return t.proximity >= t.tension ? "confidant" : "gossip";
}

/**
 * Seed-stable ranking of ripe player-bound secrets, most-ripe first. Computes `ripeness` for each, DROPS
 * any below the relevance floor (a secret about someone the player has no proximity AND no tension with is
 * not ripe enough to edge toward them — it keeps churning off-screen NPC↔NPC), and sorts descending by
 * ripeness with the thread `id` as the deterministic tiebreaker (so the order is a pure function of the
 * inputs — never insertion order, never an rng). Pure; the eligibility roll on the TOP candidate lives in
 * the adapter on a dedicated side rng.
 */
export function rankPlayerBoundThreads(threads: readonly PlayerBoundThread[]): RankedThread[] {
  return threads
    .map((t) => ({ ...t, ripeness: ripeness(t), channel: channelFor(t) }))
    .filter((t) => t.ripeness >= SECRET_PACING.ripenessFloor)
    .sort((a, b) => (b.ripeness - a.ripeness) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The sealed per-week drip-budget state the pacing pass reads (persisted across a restart, never shown). */
export interface WeekBudgetState {
  /** The week the counter below is FOR (a new week resets the count — the cadence is per-week). */
  week: number;
  /** How many player-bound drips have already fired this week. */
  spentThisWeek: number;
  /** The live week (so a stale counter from a prior week is treated as 0 spent). */
  currentWeek: number;
}

/** The budget decision for THIS tick: whether the weekly ceiling still allows a player-bound drip. */
export interface BudgetDecision {
  /** True ⇒ the weekly budget is not spent; a ripe candidate MAY drip this tick (the season cap binds too). */
  allowed: boolean;
  /** The count of drips already spent in the CURRENT week (0 when the stored counter is from a prior week). */
  spent: number;
  /** True once the weekly TARGET band's floor is reached (telemetry — the cadence is in its band). */
  atTargetMin: boolean;
}

/**
 * The weekly drip-budget gate (the pace). A NEW week resets the spent count to 0 (the cadence is per-week,
 * not per-tick); the HARD ceiling (`maxDripsPerWeek`) is the firehose stop. Surplus ripe threads still do
 * their normal 0060 off-screen NPC↔NPC surfacing — only the player-bound channel is paced here. Pure.
 *
 * (The season cap `THREAD.maxSurfacedPerSeason` is a SEPARATE, layered ceiling the adapter checks — the
 * weekly budget can never push the season total past it; it only shapes those scarce reveals into a pace.)
 */
export function dripBudget(state: WeekBudgetState): BudgetDecision {
  const C = SECRET_PACING;
  const spent = state.week === state.currentWeek ? Math.max(0, state.spentThisWeek) : 0;
  return {
    allowed: spent < C.maxDripsPerWeek,
    spent,
    atTargetMin: spent >= C.weeklyTargetMin,
  };
}

/**
 * Derive `proximity` (mutual closeness) and `tension` (friction) from the BOTH-WAY player↔source edges —
 * the engine's own directed reads, both ways. proximity = mean(trust+affinity) across both directions;
 * tension = the strongest friction in EITHER direction (high threat / low affinity — the player side-eyes
 * them, or they are wary of the player). Pure; reads only the already-read edges, returns only [0,1] reads.
 */
export function relationshipReads(
  playerToSource: Pick<EdgeSignals, "trust" | "affinity" | "threat">,
  sourceToPlayer: Pick<EdgeSignals, "trust" | "affinity" | "threat">,
): { proximity: number; tension: number } {
  const p2s = playerToSource;
  const s2p = sourceToPlayer;
  const proximity = clamp01(((p2s.trust + p2s.affinity) / 2 + (s2p.trust + s2p.affinity) / 2) / 2);
  // Friction is THREAT dampened by affinity — the line between tension (you read them as a danger) and
  // mere distance (you're just not close). A high-threat rival reads high; a no-threat bystander reads
  // ~0 however cold the bond. Take the stronger of the two directions — a secret about a rival YOU doubt,
  // or one who is wary of YOU, is equally catch-worthy.
  const frictionOf = (e: Pick<EdgeSignals, "affinity" | "threat">): number =>
    clamp01(e.threat - e.affinity * SECRET_PACING.tensionAffinityCushion);
  const tension = Math.max(frictionOf(p2s), frictionOf(s2p));
  return { proximity, tension };
}
