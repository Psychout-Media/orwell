import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import type { PlanStore } from "../../src/engine/dealPlans";

/**
 * REPORT, NOT A GATE (0178; Ryne's Q1, 2026-11-17: "measure the rate and report it; never cap it"). Plays N chat-paced seeded games (the house-mix guard's own
 * driver) and prints how often NPCs agreed to a deal with a two-faced plan, by plan kind, and by how many deals the holder had made before (the deal-count lean),
 * plus how the plans played out. Skipped unless ORWELL_PLANS_REPORT=1. ORWELL_PLANS_REPORT_SEEDS (default 12), ORWELL_PLANS_REPORT_MESSAGES (default 1500).
 */
const RUN = process.env.ORWELL_PLANS_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_PLANS_REPORT_SEEDS ?? "12", 10);
const MSGS = Number.parseInt(process.env.ORWELL_PLANS_REPORT_MESSAGES ?? "1500", 10);
type Deal = { id: string; parties: string[]; madeWeek?: number };

describe.skipIf(!RUN)("two-faced deals report (not a gate)", () => {
  it("prints the rate of two-faced plans, by kind and by deals made before", async () => {
    const byParty: Record<string, { n: number; twoFaced: number }> = {};
    const byKind: Record<string, number> = {}, byCount: Record<string, { n: number; twoFaced: number }> = {}, outcomes: Record<string, number> = {};
    let total = 0;
    const perSeed: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const before = total, keepBefore = byKind.keep ?? 0;
      await playMixGame(seed, MSGS, { advanceEvery: 6, inspect: (s) => {
        const sess = s as { live?: { dealPlans?: PlanStore }; deals: { all: readonly Deal[] } };
        const plans = sess.live?.dealPlans ?? {};
        const deals = [...sess.deals.all];
        for (const [dealId, byHolder] of Object.entries(plans)) {
          const idx = deals.findIndex((d) => d.id === dealId);
          for (const [holder, p] of Object.entries(byHolder)) {
            total++;
            const party = deals[idx]?.parties.includes("player") ? "npc-to-player" : "npc-to-npc";
            const bp = (byParty[party] ??= { n: 0, twoFaced: 0 }); bp.n++; if (p.kind !== "keep") bp.twoFaced++;
            byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
            outcomes[`${p.kind}:${p.outcome ?? "pending"}`] = (outcomes[`${p.kind}:${p.outcome ?? "pending"}`] ?? 0) + 1;
            const before = deals.slice(0, Math.max(0, idx)).filter((d) => d.parties.includes(holder)).length;
            const bucket = before >= 6 ? "6+" : String(before);
            const c = (byCount[bucket] ??= { n: 0, twoFaced: 0 });
            c.n++; if (p.kind !== "keep") c.twoFaced++;
          }
        }
      } });
      const n = total - before, keeps = (byKind.keep ?? 0) - keepBefore;
      perSeed.push(`${seed}:${n ? ((100 * (n - keeps)) / n).toFixed(0) : "-"}% of ${n}`);
    }
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "-");
    console.log(`DEALPLANS seeds=${N} plans=${total} two-faced=${pct(total - (byKind.keep ?? 0), total)}% by-kind ${JSON.stringify(byKind)}`);
    console.log(`DEALPLANS by deals-made-before: ${Object.entries(byCount).sort().map(([k, v]) => `${k}: ${pct(v.twoFaced, v.n)}% of ${v.n}`).join(" | ")}`);
    console.log(`DEALPLANS outcomes ${JSON.stringify(outcomes)}`);
    console.log(`DEALPLANS by party: ${Object.entries(byParty).map(([k, v]) => `${k}: ${pct(v.twoFaced, v.n)}% of ${v.n}`).join(" | ")}`);
    console.log(`DEALPLANS two-faced share per season: ${perSeed.join(" | ")}`);
  }, 3_600_000);
});
