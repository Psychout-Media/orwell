import { describe, it } from "vitest";
import { playDealsGame } from "../support/npcDealsDriver";

/**
 * Feature 0174 - REPORT, NOT A GATE. Plays N paired PLAYED seasons (same seeds) with ORWELL_TRIADS on and off and prints how often a vote was courted, how many were close, kingmakers, the total drift and who won.
 * Skipped unless ORWELL_TRIADS_REPORT=1. ORWELL_TRIADS_REPORT_SEEDS sets N (default 8), ORWELL_TRIADS_REPORT_START the first seed, ORWELL_TRIADS_REPORT_WEEKS stops each season at that week.
 *   ORWELL_TRIADS_REPORT=1 npx vitest run tests/calibration/triadsReport.test.ts
 */
const RUN = process.env.ORWELL_TRIADS_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_TRIADS_REPORT_SEEDS ?? "8", 10);
const START = Number.parseInt(process.env.ORWELL_TRIADS_REPORT_START ?? "1", 10);
const MAX_WEEK = Number.parseInt(process.env.ORWELL_TRIADS_REPORT_WEEKS ?? "99", 10);
type L = { finished?: boolean; winner?: string; triads?: { drift?: Record<string, number>; courted?: Array<{ voter: string; tier: number }>; kingmakers?: unknown[] }; voteRecord?: unknown[] };
async function play(seed: number, on: boolean) {
  const prev = process.env.ORWELL_TRIADS; process.env.ORWELL_TRIADS = on ? "1" : "0";
  try {
    const g = await playDealsGame(seed, 9000, { advanceEvery: 6, user: `triads-report-${seed}-${on}`, until: (x) => (x.session as unknown as { live: L }).live.finished === true || x.week() >= MAX_WEEK });
    return (g.session as unknown as { live: L }).live;
  } finally { if (prev === undefined) delete process.env.ORWELL_TRIADS; else process.env.ORWELL_TRIADS = prev; }
}
describe.skipIf(!RUN)("0174 report: triads, swing votes and kingmakers, paired played seasons (not a gate)", () => {
  it("prints courted votes, kingmakers and drift", async () => {
    const on: L[] = [], off: L[] = [];
    for (let seed = START; seed < START + N; seed++) { off.push(await play(seed, false)); on.push(await play(seed, true)); }
    const sum = (rows: L[], f: (l: L) => number): number => rows.reduce((a, l) => a + f(l), 0);
    console.log(`TRIADS ON: seasons ${on.length} | evictions ${sum(on, (l) => l.voteRecord?.length ?? 0)} | courted ${sum(on, (l) => l.triads?.courted?.length ?? 0)} (player ${sum(on, (l) => l.triads?.courted?.filter((c) => c.voter === "player").length ?? 0)}, tier 2+ ${sum(on, (l) => l.triads?.courted?.filter((c) => c.tier >= 2).length ?? 0)}) | kingmakers ${sum(on, (l) => l.triads?.kingmakers?.length ?? 0)} | drifted pairs ${sum(on, (l) => Object.keys(l.triads?.drift ?? {}).length)} | player wins ${on.filter((l) => l.winner === "player").length}`);
    console.log(`TRIADS OFF: seasons ${off.length} | evictions ${sum(off, (l) => l.voteRecord?.length ?? 0)} | player wins ${off.filter((l) => l.winner === "player").length}`);
    let changed = 0; for (let i = 0; i < on.length; i++) if (on[i]!.winner !== off[i]!.winner) changed++;
    console.log(`TRIADS winners changed ON vs OFF: ${changed} of ${on.length}`);
  }, 3_600_000);
});
