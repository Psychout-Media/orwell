import type { Clock } from "../../ports/Clock";

/**
 * The runtime `Clock` (real-time purge 2026-07-10, PO ruling — replaces the deleted `SystemClock`,
 * and makes feature 0108's opt-in logical clock the ONLY clock). A **passive** virtual clock: it
 * starts at a FIXED epoch and advances ONLY when the composition explicitly steps it — once per
 * committed mutation (see `composeRuntime`). It NEVER reads `Date.now()`, so nothing in the game is
 * tied to real-world time — the house lives on the play-clock alone.
 *
 * Crucially `now()` is a pure READ and never advances the clock: read counts are wall-clock-paced
 * (the driver's quiesce polls) and must stay clock-neutral, so identical committed-mutation
 * sequences ⇒ identical clock sequences ⇒ identical tick behavior at any pacing (this is exactly
 * what made 0108's golden record/replay deterministic — now simply always-on). Deterministic and
 * run-to-run reproducible, unlike the old wall-clock source.
 */
export class LogicalClock implements Clock {
  private t: number;

  constructor(epochMs = 0) {
    this.t = epochMs;
  }

  /** A pure read — never advances the clock (only an explicit `advance()` moves time). */
  now(): number {
    return this.t;
  }

  /** ORW-730: a resumed season brings the play-clock back to where its save left it (only ever forward, never back). */
  raiseTo(ms: number): void {
    if (Number.isFinite(ms) && ms > this.t) this.t = ms;
  }

  /** Step the clock forward by `ms` (composition calls this once per committed mutation). */
  advance(ms: number): void {
    this.t += ms;
  }
}
