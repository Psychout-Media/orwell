import { describe, it } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import type { DealPlan } from "../../src/engine/npcDeals";

/**
 * Feature 0170 - REPORT, NOT A GATE (no cap on false deals, per the owner's ruling: the rate is measured and reported, never limited). Plays N paired PLAYED seasons (same seeds) with the NPC-deal layer ON
 * (an in-memory plan store injected, so plans exist and steer the nominations) and OFF (the season as it was), and prints: pacts made, kept, broken and still open; by the holder's plan kind; per season culture.
 * Skipped unless ORWELL_NPC_DEALS_REPORT=1. ORWELL_NPC_DEALS_REPORT_SEEDS sets N (default 12).
 *   ORWELL_NPC_DEALS_REPORT=1 npx vitest run tests/calibration/npcDealsReport.test.ts
 */
const RUN = process.env.ORWELL_NPC_DEALS_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_NPC_DEALS_REPORT_SEEDS ?? "12", 10);
type Deal = { id: string; status: string; parties: string[]; kind: string };
type S = { createCharacter(a: unknown): void; advanceGame(): { pending?: unknown }; submitDecision(r: unknown): unknown; noteMessage(a: unknown): void; getGameState(): unknown; turnIn(a: unknown): unknown; settleOvernight(n: number): void; advanceClockPerConversation(): void; setPerConversationClockEnabled(on: boolean): void; deals: { npcOnly(): Deal[] }; setNpcDealsEnabled(on: boolean): void; setPlanSource(s: unknown): void; setRecordPlan(f: unknown): void; live: { houseLeans?: Array<{ id: string }> | Record<string, unknown>; finished?: boolean; nightDepth?: number; timeOfDay?: string; pending?: unknown; winner?: string; finalTwo?: string[]; evictionOrder: string[] } };
interface Row { seed: number; deals: Deal[]; plans: Map<string, DealPlan>; leans: string[]; winner?: string; playerOut: number | null; finished: boolean }

function play(seed: number, on: boolean): Row {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`npcdeals-report-${seed}-${on}`).session as unknown as S;
  s.createCharacter({ playerName: "P", seed });
  const plans = new Map<string, DealPlan>();
  s.setNpcDealsEnabled(on);
  if (on) { s.setRecordPlan((d: string, h: string, p: DealPlan) => plans.set(`${d}|${h}`, p)); s.setPlanSource({ planOf: (d: string, h: string) => plans.get(`${d}|${h}`) }); }
  s.setPerConversationClockEnabled(true);
  const live = (): S["live"] => s.live;
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) s.advanceGame();
  s.noteMessage({ messageId: "npcdeals-report-0" });
  for (let step = 0; step < 40_000 && !live().finished; step++) {
    const l = live();
    const d = (s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule;
    if (d?.due || !d || l.pending) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending as never, (req) => void s.submitDecision(req)); }
    else if (l.timeOfDay === "night" || l.timeOfDay === "late-night") { const r = s.turnIn({}) as { held?: unknown } | undefined; if (!r?.held) s.settleOvernight(1); }
    else s.advanceClockPerConversation();
  }
  const l = live();
  const idx = l.evictionOrder.indexOf("player");
  const leans = Array.isArray(l.houseLeans) ? l.houseLeans.map((x) => x.id) : [];
  return { seed, deals: s.deals.npcOnly(), plans, leans, ...(l.winner ? { winner: l.winner } : {}), playerOut: idx >= 0 ? idx + 1 : null, finished: l.finished === true };
}
const count = (rows: Row[], f: (d: Deal) => boolean): number => rows.reduce((a, r) => a + r.deals.filter(f).length, 0);

describe.skipIf(!RUN)("0170 report: NPC deals and plans, paired played seasons (not a gate)", () => {
  it("prints deals made / kept / broken, by plan kind and by culture", () => {
    const on: Row[] = [], off: Row[] = [];
    for (let seed = 1; seed <= N; seed++) { off.push(play(seed, false)); on.push(play(seed, true)); }
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
