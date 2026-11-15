/**
 * ORW-404 — cheap, dependency-free stall timing (measurement only, no behaviour change).
 *
 * Records the wall-clock cost of the steps suspected of freezing the single Node thread (save persist
 * phases, embed calls, the resume index rebuild). Every step bumps a counter; only a step that exceeds
 * the threshold (`ORWELL_STALL_LOG_MS`, default 500) writes ONE line to stderr. Never draws from any
 * rng, never reads game content: a line carries the step name, durations and byte/char/count SIZES only.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 500;

export interface StallStat { count: number; slow: number; totalMs: number; maxMs: number }

export type StallSink = (line: string) => void;
export type StallClock = () => number;

export class StallTimer {
  private readonly stats = new Map<string, StallStat>();

  constructor(
    private readonly sink: StallSink = (l) => console.error(l),
    private readonly clock: StallClock = () => performance.now(),
    private readonly thresholdMs: () => number = envThresholdMs,
  ) {}

  now(): number { return this.clock(); }

  /** Record one step. `phases` are optional sub-durations (ms); `sizes` are plain numbers (bytes/chars/items). */
  record(step: string, durationMs: number, sizes: Record<string, number> = {}, phases: Record<string, number> = {}): void {
    const d = Math.max(0, durationMs);
    const s = this.stats.get(step) ?? { count: 0, slow: 0, totalMs: 0, maxMs: 0 };
    s.count += 1;
    s.totalMs += d;
    if (d > s.maxMs) s.maxMs = d;
    this.stats.set(step, s);
    if (d <= this.thresholdMs()) return;
    s.slow += 1;
    const fields = [
      `step=${step}`,
      `ms=${Math.round(d)}`,
      ...Object.entries(phases).map(([k, v]) => `${k}Ms=${Math.round(v)}`),
      ...Object.entries(sizes).map(([k, v]) => `${k}=${Math.round(v)}`),
    ];
    try { this.sink(`[orwell] SLOW ${fields.join(" ")}`); } catch { /* logging must never break the game */ }
  }

  /** Counters for `/health`: per step count / slow / total / max (ms). No content, no ids. */
  snapshot(): Record<string, StallStat> {
    const out: Record<string, StallStat> = {};
    for (const [k, v] of this.stats) out[k] = { count: v.count, slow: v.slow, totalMs: Math.round(v.totalMs), maxMs: Math.round(v.maxMs) };
    return out;
  }
}

function envThresholdMs(): number {
  const n = Number(process.env.ORWELL_STALL_LOG_MS);
  return Number.isFinite(n) && n >= 0 && process.env.ORWELL_STALL_LOG_MS !== undefined && process.env.ORWELL_STALL_LOG_MS !== ""
    ? n : DEFAULT_STALL_THRESHOLD_MS;
}

/** Process-wide timer used by the adapters (tests inject their own via the constructor/setter). */
export let stallTimer = new StallTimer();
export function setStallTimerForTests(t: StallTimer): void { stallTimer = t; }
