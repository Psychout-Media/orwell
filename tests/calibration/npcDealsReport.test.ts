import { describe, it } from "vitest";
import { playDealsGame } from "../support/npcDealsDriver";
type DealPlan = { kind: string; moment?: unknown; outcome?: string };

/**
 * Feature 0170 - REPORT, NOT A GATE (no cap on false deals, per the owner's ruling: the rate is measured and reported, never limited). Plays N paired PLAYED seasons (same seeds) with the NPC-deal layer ON
 * (PLAYED path: main's 0178 planner plans every pact and carries the betrayals out; plans are read from `live.dealPlans`) and OFF (the season as it was), and prints: pacts made, kept, broken and still open; by the holder's plan kind; per season culture.
 * Skipped unless ORWELL_NPC_DEALS_REPORT=1. ORWELL_NPC_DEALS_REPORT_SEEDS sets N (default 12), ORWELL_NPC_DEALS_REPORT_START the first seed (default 1), ORWELL_NPC_DEALS_REPORT_WEEKS stops each season at that week (default: play to the crown; a full chat-paced season is slow).
 *   ORWELL_NPC_DEALS_REPORT=1 npx vitest run tests/calibration/npcDealsReport.test.ts
 */
const RUN = process.env.ORWELL_NPC_DEALS_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_NPC_DEALS_REPORT_SEEDS ?? "12", 10);
const MAX_WEEK = Number.parseInt(process.env.ORWELL_NPC_DEALS_REPORT_WEEKS ?? "99", 10);
const START = Number.parseInt(process.env.ORWELL_NPC_DEALS_REPORT_START ?? "1", 10);
type Deal = { id: string; status: string; parties: string[]; kind: string };
type S = { deals: { npcOnly(): Deal[] }; setNpcDealsEnabled(on: boolean): void; live: { dealPlans?: Record<string, Record<string, DealPlan>>; houseLeans?: Array<{ id: string }> | Record<string, unknown>; finished?: boolean; nightDepth?: number; timeOfDay?: string; pending?: unknown; winner?: string; finalTwo?: string[]; evictionOrder: string[] } };
interface Row { seed: number; deals: Deal[]; plans: Map<string, DealPlan>; leans: string[]; winner?: string; playerOut: number | null; finished: boolean }

async function play(seed: number, on: boolean): Promise<Row> {
  const prev = process.env.ORWELL_NPC_DEALS; process.env.ORWELL_NPC_DEALS = on ? "1" : "0";
  const plans = new Map<string, DealPlan>();
  try {
    // The mix-driver pace (a message per tick, an advance every 6th): the chat-paced path is the one that runs the ceremony hooks the pacts hang on.
    const g = await playDealsGame(seed, 9000, {
      advanceEvery: 6, user: `npcdeals-report-${seed}-${on}`,
      until: (x) => (x.session as unknown as S).live.finished === true || x.week() >= MAX_WEEK,
    });
    const s = g.session as unknown as S; const l = s.live;
    for (const [d, by] of Object.entries(l.dealPlans ?? {})) for (const [h, p] of Object.entries(by)) plans.set(`${d}|${h}`, p);
    const idx = l.evictionOrder.indexOf("player");
    const leans = Array.isArray(l.houseLeans) ? l.houseLeans.map((x) => x.id) : [];
    return { seed, deals: s.deals.npcOnly(), plans, leans, ...(l.winner ? { winner: l.winner } : {}), playerOut: idx >= 0 ? idx + 1 : null, finished: l.finished === true };
  } finally { if (prev === undefined) delete process.env.ORWELL_NPC_DEALS; else process.env.ORWELL_NPC_DEALS = prev; }
}
const count = (rows: Row[], f: (d: Deal) => boolean): number => rows.reduce((a, r) => a + r.deals.filter(f).length, 0);

describe.skipIf(!RUN)("0170 report: NPC deals and plans, paired played seasons (not a gate)", () => {
  it("prints deals made / kept / broken, by plan kind and by culture", async () => {
    const on: Row[] = [], off: Row[] = [];
    for (let seed = START; seed < START + N; seed++) { off.push(await play(seed, false)); on.push(await play(seed, true)); }
    for (const [name, rows] of [["OFF", off], ["ON", on]] as const) {
      const made = count(rows, () => true), kept = count(rows, (d) => d.status === "kept"), broken = count(rows, (d) => d.status === "broken"), open = count(rows, (d) => d.status === "open");
      console.log(`NPCDEALS ${name}: seasons ${rows.length} finished ${rows.filter((r) => r.finished).length} | NPC pacts ${made} (${(made / rows.length).toFixed(1)}/season) kept ${kept} broken ${broken} open ${open} | broken share ${((100 * broken) / Math.max(1, made)).toFixed(0)}% | player wins ${rows.filter((r) => r.winner === "player").length}`);
    }
    const byPlan = new Map<string, { n: number; broken: number }>();
    for (const r of on) for (const d of r.deals) for (const h of d.parties) {
      const p = r.plans.get(`${d.id}|${h}`); const k = p ? p.kind : "none";
      const e = byPlan.get(k) ?? { n: 0, broken: 0 }; e.n++; if (d.status === "broken") e.broken++; byPlan.set(k, e);
    }
    console.log(`NPCDEALS ON by holder plan: ${[...byPlan].map(([k, v]) => `${k} ${v.n} (pact broken ${v.broken})`).join(" | ")}`);
    const byLean = new Map<string, { seasons: number; deals: number; broken: number }>();
    for (const r of on) for (const id of r.leans) { const e = byLean.get(id) ?? { seasons: 0, deals: 0, broken: 0 }; e.seasons++; e.deals += r.deals.length; e.broken += r.deals.filter((d) => d.status === "broken").length; byLean.set(id, e); }
    console.log(`NPCDEALS ON by season culture lean: ${[...byLean].map(([k, v]) => `${k}: ${v.seasons} seasons, ${v.deals} pacts, ${v.broken} broken`).join(" | ")}`);
    let changed = 0; for (let i = 0; i < on.length; i++) if (on[i]!.winner !== off[i]!.winner) changed++;
    console.log(`NPCDEALS winners changed ON vs OFF: ${changed} of ${on.length}`);
  }, 3_600_000);
});
