import type { RandomnessSource } from "../ports/RandomnessSource";

/**
 * Reserve twists (feature 0025) — a small curated pool of classic, NON-STRUCTURAL
 * production twists held in reserve. The engine decides, seeded, WHETHER a reserved
 * twist is in play and WHEN it fires (a dramatic beat). Until it fires, the choice
 * and its timing are Vault-sealed — invisible to the player AND the admin (mandate
 * #2). Firing reveals it as a witnessed event. Twists never break the core arc
 * (16 → jury-9 → final-2) or the hard rules (0005); they add variance along the way.
 *
 * PURE + seed-deterministic. The chosen twists are Vault content (engine-only);
 * this module only computes them — it never surfaces them.
 */
// BE-15 / PO ruling 2026-07-06: this one-time SAFETY twist is named "secret-veto" — descriptive of the
// mechanic (a hidden veto that pulls the holder off the block) and deliberately NOT "secret-power": the
// unrelated, fully-built 0093 feature ("secrets as leverage/currency") owns the "secret power" /
// `secretPower` vocabulary, and a twist kind sharing that name risked a maintainer wiring the wrong system.
export type TwistKind = "secret-veto" | "double-eviction" | "battle-back";

/** Curated, format-preserving pool. May hold more kinds than the live loop currently implements — see
 *  `IMPLEMENTED_TWISTS`/`DOCUMENTED_UNIMPLEMENTED_TWISTS` below, which together must account for every
 *  kind here (BE-14's same-file guard). */
export const RESERVE_POOL: readonly TwistKind[] = ["secret-veto", "double-eviction", "battle-back"];

/**
 * BE-3/BE-14 — the twist kinds the LIVE loop actually implements a firing handler for. Single source of
 * truth, co-located with `RESERVE_POOL` in this file (previously duplicated as a local constant in
 * `GameSessionAdapter.ts`, with nothing tying the two together). `loadReserveTwists` draws ONLY from
 * this set (never the full pool) — see the fix note there for why that matters.
 */
export const IMPLEMENTED_TWISTS: ReadonlySet<TwistKind> = new Set<TwistKind>(["double-eviction"]);

/**
 * BE-14 — kinds in `RESERVE_POOL` that are DELIBERATELY not yet wired into the live loop (reserved for a
 * later wave), documented here so a future addition to the pool can't silently go unaccounted for. Every
 * kind in `RESERVE_POOL` must be in `IMPLEMENTED_TWISTS` or here — the assertion below enforces it.
 */
const DOCUMENTED_UNIMPLEMENTED_TWISTS: ReadonlySet<TwistKind> = new Set<TwistKind>(["secret-veto", "battle-back"]);

// BE-14 — a same-file structural guard, checked once at module load: if a future kind is added to
// `RESERVE_POOL` without being wired into `IMPLEMENTED_TWISTS` OR explicitly documented above as a
// future reserve slot, fail loudly instead of silently shipping a phantom twist that can be seeded and
// sealed to the Vault but can never fire (the exact class of bug BE-3 fixes for the pre-existing kinds).
for (const kind of RESERVE_POOL) {
  if (!IMPLEMENTED_TWISTS.has(kind) && !DOCUMENTED_UNIMPLEMENTED_TWISTS.has(kind)) {
    throw new Error(
      `reserveTwists: RESERVE_POOL kind "${kind}" is neither IMPLEMENTED_TWISTS nor DOCUMENTED_UNIMPLEMENTED_TWISTS — account for it in src/engine/reserveTwists.ts`,
    );
  }
}

/** Chance an enabled reserve slot actually loads a twist (B59 — tunable, often none fire). */
export const TWIST_LOAD_PROB = 0.5;

/** A loaded-but-SEALED reserve twist: what it is and the (hidden) beat it fires at. */
export interface ReserveTwist {
  kind: TwistKind;
  fireAtBeat: number;
}

export interface TwistEvent {
  kind: TwistKind;
  beat: number;
}

/** The weekly eviction beats are the season's dramatic beats a twist may fire at. */
export function isDramaticBeat(beat: number, totalBeats = 14): boolean {
  return beat >= 2 && beat <= totalBeats - 1;
}

/**
 * BE-3 — the pool `loadReserveTwists` actually draws a KIND from: restricted to `IMPLEMENTED_TWISTS`.
 * The pre-existing bug drew from the FULL curated `RESERVE_POOL` and filtered unimplemented kinds OUT
 * AFTER the pick (at the `GameSessionAdapter` call site), which wasted 2 of every 3 loaded slots on a
 * twist that could never fire — silently diluting the effective load rate for the one shipped twist to
 * roughly a THIRD of the documented ~50% (`TWIST_LOAD_PROB`). Filtering the pool BEFORE the draw (never
 * reordering or adding rng calls) keeps the seeded draw SHAPE — one coin-flip `next()`, then one kind
 * `int()`, then one fireAtBeat `int()`, per loaded slot — byte-identical; only the mapping from the
 * kind-draw's random value to a `TwistKind` changes (ENDGAME-16/ENDGAME-7).
 */
const IMPLEMENTED_POOL: readonly TwistKind[] = RESERVE_POOL.filter((k) => IMPLEMENTED_TWISTS.has(k));

/**
 * Seed which reserved twists (≤ `count`) are actually in play and when each fires.
 * Rare by construction — each enabled slot is only ~50% likely to be loaded, and
 * even then fires once, at a seeded dramatic beat. Same seed ⇒ same result.
 */
export function loadReserveTwists(count: number, rng: RandomnessSource, totalBeats = 14): ReserveTwist[] {
  const slots = Math.max(0, Math.min(count, RESERVE_POOL.length));
  const out: ReserveTwist[] = [];
  for (let i = 0; i < slots; i++) {
    if (rng.next() < 1 - TWIST_LOAD_PROB) continue; // often none, even when enabled
    if (IMPLEMENTED_POOL.length === 0) continue; // nothing implemented yet ⇒ this slot loads nothing
    const kind = IMPLEMENTED_POOL[rng.int(IMPLEMENTED_POOL.length)]!;
    // A dramatic mid-season beat (never the premiere, never the finale week).
    const fireAtBeat = 2 + rng.int(Math.max(1, totalBeats - 3));
    // G20 — same-file structural tie (the BE-14 pattern): this arithmetic must never drift outside
    // the range `isDramaticBeat` names as valid. Production's range is (and must stay) a strict
    // subset of the predicate's, so this never fires today — it's a fail-loud guard against the
    // exact duplication-drift bug class this file has been bitten by before (BE-3/BE-14/ENDGAME-16/
    // ENDGAME-7), and it gives `isDramaticBeat` a real production call site instead of only the
    // test-only sanity check it previously had. Deliberately does NOT change the seeded draw shape
    // (still one `rng.int()` call per loaded slot) — no calibration impact.
    if (!isDramaticBeat(fireAtBeat, totalBeats)) {
      throw new Error(
        `reserveTwists: loadReserveTwists computed fireAtBeat=${fireAtBeat} (totalBeats=${totalBeats}) outside isDramaticBeat's range — reconcile the two in src/engine/reserveTwists.ts`,
      );
    }
    out.push({ kind, fireAtBeat });
  }
  return out;
}

/** At a given beat, the reserved twist (if any) that fires now — deterministic, rare. */
export function maybeFireTwist(beat: number, reserve: readonly ReserveTwist[]): TwistEvent | null {
  const t = reserve.find((r) => r.fireAtBeat === beat);
  return t ? { kind: t.kind, beat } : null;
}

/** Play out the season's beats and collect the twists that fire (≤ the loaded count). */
export function firedTwists(reserve: readonly ReserveTwist[], totalBeats = 14): TwistEvent[] {
  const out: TwistEvent[] = [];
  for (let beat = 1; beat <= totalBeats; beat++) {
    const ev = maybeFireTwist(beat, reserve);
    if (ev) out.push(ev);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// REACTIVE model (feature 0025 redesign, PO ruling 2026-07-06). The whole pool stands
// armed from game start; each twist WATCHES the live house and fires when the house
// reaches a state that EARNS it — not a week pre-picked at setup. The trigger THRESHOLDS
// are re-rolled per season (the "dynamic triggers"), so the same conditions do not recur
// season to season; and even an earned trigger can be HELD BACK by a seeded per-season
// arming roll, so some seasons stay quiet. Everything here is PURE + seed-deterministic;
// the plan is Vault content (engine-only), sealed until a twist fires.
//
// Gated live behind ORWELL_REACTIVE_TWISTS — flag off keeps the legacy pre-scheduled path
// above (byte-identical), so the calibration baseline is untouched.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sealed per-season plan: the seeded thresholds that decide WHEN each twist becomes
 * eligible, plus whether each is armed at all this season (the hold-back). Re-rolled fresh
 * every season, so no two playthroughs share the same trigger conditions.
 */
export interface TwistPlan {
  /** Fire the double eviction the first week the active house is at or below this size. */
  doubleEvictionAtActive: number;
  doubleEvictionArmed: boolean;
  /** Fire the secret veto once the lopsided-eviction streak reaches this length. */
  secretVetoStreak: number;
  secretVetoArmed: boolean;
  /** Fire the battle-back once this many jurors have been seated (early-jury window). */
  battleBackAtJury: number;
  battleBackArmed: boolean;
}

/** The compact live-house snapshot the triggers read (roles/counts only — no identities). */
export interface TwistSignals {
  /** Houseguests still in the game. */
  activeCount: number;
  /** Jurors seated so far (0 before the jury phase). */
  juryCount: number;
  /** Consecutive near-unanimous ("the house steamrolled") evictions — the lopsided-house signal. */
  lopsidedStreak: number;
}

/** The seeded threshold bands (the "dynamic" ranges the per-season pick is drawn from). */
export const DOUBLE_EVICTION_ACTIVE_BAND: readonly [number, number] = [6, 9];
export const SECRET_VETO_STREAK_BAND: readonly [number, number] = [2, 3];
export const BATTLE_BACK_JURY_BAND: readonly [number, number] = [1, 3];
/** Chance an enabled twist is actually armed this season (else it is held back — some seasons stay quiet). */
export const TWIST_ARM_PROB = 0.6;
/** Below this many active houseguests, no NEW twist arms — too little game left to stay format-preserving. */
export const TWIST_MIN_ACTIVE = 5;

function pickInBand(rng: RandomnessSource, [lo, hi]: readonly [number, number]): number {
  return lo + rng.int(hi - lo + 1);
}

/**
 * Roll the sealed per-season twist plan (the dynamic thresholds + the hold-back arming). Drawn in a
 * FIXED field order off the given (dedicated, per-season) rng, so the same seed reproduces the same
 * plan and a different seed yields different trigger conditions.
 */
export function planReserveTwists(rng: RandomnessSource): TwistPlan {
  return {
    doubleEvictionAtActive: pickInBand(rng, DOUBLE_EVICTION_ACTIVE_BAND),
    doubleEvictionArmed: rng.next() < TWIST_ARM_PROB,
    secretVetoStreak: pickInBand(rng, SECRET_VETO_STREAK_BAND),
    secretVetoArmed: rng.next() < TWIST_ARM_PROB,
    battleBackAtJury: pickInBand(rng, BATTLE_BACK_JURY_BAND),
    battleBackArmed: rng.next() < TWIST_ARM_PROB,
  };
}

/**
 * Which twist (if any) is triggered by the live house RIGHT NOW, given the sealed plan, the current
 * signals, and what has already fired (each fires at most once). Returns at most one — so the caller,
 * evaluating once per week roll, naturally spaces twists across different weeks (the cooldown). The
 * order below is the priority when two are eligible the same roll; the deferred one persists (its
 * threshold is monotonic) and fires the next roll.
 */
export function triggeredTwist(
  plan: TwistPlan,
  sig: TwistSignals,
  fired: readonly TwistKind[],
): TwistKind | null {
  const done = new Set(fired);
  if (sig.activeCount < TWIST_MIN_ACTIVE) return null; // too little game left to stay format-preserving
  // Battle-back first: its early-jury window is the narrowest and closes as the jury fills.
  // ORW-1088: the field is jurors only, so it waits for a second juror (a field of one is no contest); the plan's draw is unchanged.
  if (plan.battleBackArmed && !done.has("battle-back") && sig.juryCount >= Math.max(2, plan.battleBackAtJury) && sig.juryCount <= plan.battleBackAtJury + 1)
    return "battle-back";
  // Double eviction: the first week the house has shrunk to the seeded target size.
  if (plan.doubleEvictionArmed && !done.has("double-eviction") && sig.activeCount <= plan.doubleEvictionAtActive)
    return "double-eviction";
  // Secret veto: the house has gone lopsided (a run of steamroll evictions).
  if (plan.secretVetoArmed && !done.has("secret-veto") && sig.lopsidedStreak >= plan.secretVetoStreak)
    return "secret-veto";
  return null;
}
