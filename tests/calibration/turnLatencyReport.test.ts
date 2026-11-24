import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { playedGame } from "../support/playedGame";

/**
 * ORW-820 (0065 R3): does a turn still get slower as the season grows? A REPORT, not a gate (runs only with ORWELL_LATENCY_REPORT=1). Each played turn goes through the real
 * Orchestrator commit (the integrity checkpoint is the cost R3 targets), timed wall-clock. Printed per season: the median and p95 of the first, middle and last hundred turns,
 * the event-log size at each point, and the late/early ratio. R3's safe slice (the O(delta) event-prefix check + the snapshot cache) is on main; the remaining full O(delta)
 * export is built only if this shows late turns still growing toward the front-end timeout. Sandbox names pinned (`lat-<seed>`). Roles only.
 */
const ON = process.env.ORWELL_LATENCY_REPORT === "1";
const SEEDS = (process.env.LATENCY_SEEDS ?? "3,11").split(",").map(Number).filter(Number.isFinite);
const q = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };

describe.skipIf(!ON)("ORW-820: turn latency across a played season (report only)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const g = playedGame({ seed, user: `lat-${seed}` });
      const ms: number[] = [], evs: number[] = [];
      for (let i = 0; i < 6000 && !g.s.getGameState().finished; i++) {
        const t0 = performance.now();
        g.turn();
        ms.push(performance.now() - t0);
        evs.push(g.sb.engine.events.queryAll().length);
      }
      const n = ms.length, w = Math.min(100, Math.floor(n / 3));
      const band = (from: number) => ({ med: q(ms.slice(from, from + w), 0.5), p95: q(ms.slice(from, from + w), 0.95), events: evs[Math.min(n - 1, from + w - 1)] });
      const early = band(0), mid = band(Math.floor(n / 2) - Math.floor(w / 2)), late = band(n - w);
      console.log(`LATENCY seed=${seed} turns=${n} finished=${g.s.getGameState().finished} | early med ${early.med.toFixed(1)}ms p95 ${early.p95.toFixed(1)}ms ev ${early.events} | `
        + `mid med ${mid.med.toFixed(1)}ms p95 ${mid.p95.toFixed(1)}ms ev ${mid.events} | late med ${late.med.toFixed(1)}ms p95 ${late.p95.toFixed(1)}ms ev ${late.events} | `
        + `late/early med x${(late.med / early.med).toFixed(1)} p95 x${(late.p95 / early.p95).toFixed(1)} | slowest ${Math.max(...ms).toFixed(0)}ms`);
      expect(n).toBeGreaterThan(0);
    }, 3_600_000);
  }
});
