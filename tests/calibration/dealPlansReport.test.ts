import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import { isBetrayal, type PlanKind, type PlanStore } from "../../src/engine/dealPlans";

/**
 * REPORT, NOT A GATE (0178; Ryne's Q1, 2026-11-17: "measure the rate and report it; never cap it"). Plays N chat-paced seeded games (the house-mix guard's own
 * driver) and prints how often NPCs agreed to a deal with a two-faced plan, by plan kind, and by how many deals the holder had made before (the deal-count lean),
 * plus how the plans played out. Skipped unless ORWELL_PLANS_REPORT=1. ORWELL_PLANS_REPORT_SEEDS (default 12), ORWELL_PLANS_REPORT_MESSAGES (default 1500).
 */
const RUN = process.env.ORWELL_PLANS_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_PLANS_REPORT_SEEDS ?? "12", 10);
const MSGS = Number.parseInt(process.env.ORWELL_PLANS_REPORT_MESSAGES ?? "1500", 10);
/** ORWELL_PLANS_REPORT_ACTIVE=1: an ACTIVE player who proposes a deal to a houseguest in the room every 25 messages (safety, final two or a vote, in turn), so promises TO the player are measured too. */
const ACTIVE = process.env.ORWELL_PLANS_REPORT_ACTIVE === "1";
const KINDS = ["safety", "final-two", "vote"] as const;
async function onMessage(call: (name: string, args: Record<string, unknown>) => Promise<unknown>, i: number): Promise<void> {
  if (i % 25 !== 24) return;
  const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
  const others = (wa?.present ?? []).map((x) => x.id).filter((id) => id !== "player");
  if (others.length === 0) return;
  await call("makeDeal", { with: others[(i / 25) % others.length | 0], kind: KINDS[(i / 25 | 0) % KINDS.length], terms: "let's look after each other" }).catch(() => null);
}
type Deal = { id: string; parties: string[]; madeWeek?: number };

describe.skipIf(!RUN)("two-faced deals report (not a gate)", () => {
  it("prints the rate of two-faced plans, by kind and by deals made before", async () => {
    const byParty: Record<string, { n: number; twoFaced: number }> = {};
    const byArch: Record<string, { n: number; twoFaced: number }> = {};
    const carried: Record<string, { planned: number; carriedOut: number }> = {};
    const byKind: Record<string, number> = {}, byCount: Record<string, { n: number; twoFaced: number }> = {}, outcomes: Record<string, number> = {};
    let total = 0;
    const honest = () => Object.entries(byKind).filter(([k]) => !isBetrayal(k as PlanKind)).reduce((a, [, v]) => a + v, 0);
    const perSeed: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const before = total, keepBefore = honest();
      await playMixGame(seed, MSGS, { advanceEvery: 6, ...(ACTIVE ? { onMessage } : {}), inspect: (s) => {
        const sess = s as { live?: { dealPlans?: PlanStore }; deals: { all: readonly Deal[] }; house?: { npcs: Array<{ id: string; character: { archetype: string } }> } };
        const archOf = (id: string) => sess.house?.npcs.find((x) => x.id === id)?.character.archetype ?? "?";
        const plans = sess.live?.dealPlans ?? {};
        const deals = [...sess.deals.all];
        for (const [dealId, byHolder] of Object.entries(plans)) {
          const idx = deals.findIndex((d) => d.id === dealId);
          for (const [holder, p] of Object.entries(byHolder)) {
            total++;
            const party = deals[idx]?.parties.includes("player") ? "npc-to-player" : "npc-to-npc";
            const bp = (byParty[party] ??= { n: 0, twoFaced: 0 }); bp.n++; if (isBetrayal(p.kind)) bp.twoFaced++;
            const ba = (byArch[archOf(holder)] ??= { n: 0, twoFaced: 0 }); ba.n++; if (isBetrayal(p.kind)) ba.twoFaced++;
            byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
            if (isBetrayal(p.kind)) { const cb = (carried[party] ??= { planned: 0, carriedOut: 0 }); cb.planned++; if (p.outcome === "carried-out") cb.carriedOut++; }
            outcomes[`${p.kind}:${p.outcome ?? "pending"}`] = (outcomes[`${p.kind}:${p.outcome ?? "pending"}`] ?? 0) + 1;
            const before = deals.slice(0, Math.max(0, idx)).filter((d) => d.parties.includes(holder)).length;
            const bucket = before >= 6 ? "6+" : String(before);
            const c = (byCount[bucket] ??= { n: 0, twoFaced: 0 });
            c.n++; if (isBetrayal(p.kind)) c.twoFaced++;
          }
        }
      } });
      const n = total - before, keeps = honest() - keepBefore;
      perSeed.push(`${seed}:${n ? ((100 * (n - keeps)) / n).toFixed(0) : "-"}% of ${n}`);
    }
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "-");
    console.log(`DEALPLANS player=${ACTIVE ? "active" : "passive"}`);
    console.log(`DEALPLANS seeds=${N} plans=${total} two-faced=${pct(total - honest(), total)}% by-kind ${JSON.stringify(byKind)}`);
    console.log(`DEALPLANS by deals-made-before: ${Object.entries(byCount).sort().map(([k, v]) => `${k}: ${pct(v.twoFaced, v.n)}% of ${v.n}`).join(" | ")}`);
    console.log(`DEALPLANS outcomes ${JSON.stringify(outcomes)}`);
    // Coordinator 2026-11-17: report BETRAYALS CARRIED OUT (a two-faced plan whose break actually happened), not merely plans that are not "keep"
    console.log(`DEALPLANS betrayals carried out: ${Object.entries(carried).map(([k, v]) => `${k}: ${v.carriedOut} of ${v.planned} planned (${pct(v.carriedOut, v.planned)}%)`).join(" | ")}`);
    console.log(`DEALPLANS by type: ${Object.entries(byArch).sort((x, y) => y[1].twoFaced / y[1].n - x[1].twoFaced / x[1].n).map(([k, v]) => `${k}: ${pct(v.twoFaced, v.n)}% of ${v.n}`).join(" | ")}`);
    console.log(`DEALPLANS by party: ${Object.entries(byParty).map(([k, v]) => `${k}: ${pct(v.twoFaced, v.n)}% of ${v.n}`).join(" | ")}`);
    console.log(`DEALPLANS two-faced share per season: ${perSeed.join(" | ")}`);
  }, 3_600_000);
});
