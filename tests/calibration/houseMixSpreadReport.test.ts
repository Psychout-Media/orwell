import { describe, it } from "vitest";
import { playMixGame, mixShares, type MixScene } from "../support/houseMixDriver";

/**
 * REPORT, NOT A GATE (Ryne 2026-11-16: "some variability is important here"; the house-mix question). Plays N chat-paced seeded games (the
 * house-mix guard's own driver) and prints (1) the week-1 mix per seed with the min/max per category, and (2) the mix by game week across all
 * seeds (the player still in the game), to show how the mix moves season to season and within a season.
 * Skipped unless ORWELL_MIX_REPORT=1. ORWELL_MIX_REPORT_SEEDS (default 12), ORWELL_MIX_REPORT_MESSAGES (default 1500), advance every 6 messages.
 *   ORWELL_MIX_REPORT=1 npx vitest run tests/calibration/houseMixSpreadReport.test.ts
 */
const RUN = process.env.ORWELL_MIX_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_MIX_REPORT_SEEDS ?? "12", 10);
const MSGS = Number.parseInt(process.env.ORWELL_MIX_REPORT_MESSAGES ?? "1500", 10);
const fmt = (m: ReturnType<typeof mixShares>) => `${m.bonding.toFixed(1)}/${m.strategy.toFixed(1)}/${m.gossip.toFixed(1)}/${m.conflict.toFixed(1)} (n=${m.n})`;

describe.skipIf(!RUN)("house mix spread report (not a gate)", () => {
  it("prints the week-1 spread across seeds and the mix by week", async () => {
    const all: MixScene[] = [];
    const wk1: Array<ReturnType<typeof mixShares>> = [];
    for (let seed = 1; seed <= N; seed++) {
      const g = await playMixGame(seed, MSGS, { advanceEvery: 6 });
      const played = g.scenes.filter((s) => !s.playerOut);
      all.push(...played);
      const m = mixShares(played.filter((s) => s.week === 1));
      wk1.push(m);
      console.log(`MIXSPREAD seed ${seed} week1 ${fmt(m)} weeks-reached ${Math.max(...played.map((s) => s.week), 1)}`);
    }
    const k = ["bonding", "strategy", "gossip", "conflict"] as const;
    const range = k.map((c) => `${c} ${Math.min(...wk1.map((m) => m[c])).toFixed(1)}-${Math.max(...wk1.map((m) => m[c])).toFixed(1)}`).join(", ");
    console.log(`MIXSPREAD week1 all-seeds ${fmt(mixShares(all.filter((s) => s.week === 1)))} | per-seed range: ${range}`);
    const weeks = [...new Set(all.map((s) => s.week))].sort((a, b) => a - b);
    for (const w of weeks) console.log(`MIXSPREAD by-week ${w}: ${fmt(mixShares(all.filter((s) => s.week === w)))}`);
  });
});
