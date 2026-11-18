import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { proposeNpcDeal, proposeNpcDeals, planAwareDealPush, pairKeyOf, type NpcDealInputs, type PlanSource, type DealPlan } from "../../src/engine/npcDeals";
import { NPC_DEALS } from "../../src/engine/npcDealConstants";
import { NPC_DEAL_PUSH } from "../../src/engine/dealNomConstants";

/** Feature 0170 - the pure NPC-deal proposal and the plan-aware push. Roles only (NPC ids are opaque). */
const ids = Array.from({ length: 10 }, (_, i) => `npc:${i + 1}`);
const flat = (trust: number, warmth = 0.5) => ({ bond: () => ({ trust, warmth, strength: 0.5 }) });
const base = (over: Partial<NpcDealInputs> = {}): NpcDealInputs => ({
  week: 1, npcs: ids, bonds: flat(0.8), isTaken: () => false,
  stream: (k) => new SeededRandom(hashSeed(`seed-1:npc-deals:1:${k}`)), ...over,
});

describe("proposeNpcDeals", () => {
  it("same seed, same proposals; a different seed differs somewhere", () => {
    expect(proposeNpcDeals(base())).toEqual(proposeNpcDeals(base()));
    const other = proposeNpcDeals(base({ stream: (k) => new SeededRandom(hashSeed(`seed-2:npc-deals:1:${k}`)) }));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(proposeNpcDeals(base())));
  });
  it("takes its draws from a per-pair stream: a pair's outcome does not depend on the other pairs", () => {
    const solo = proposeNpcDeal(base(), "npc:1", "npc:2");
    const key = pairKeyOf("npc:1", "npc:2");
    const seen: string[] = [];
    proposeNpcDeals(base({ stream: (k) => { seen.push(k); return new SeededRandom(hashSeed(`seed-1:npc-deals:1:${k}`)); } }));
    expect(seen.length).toBeGreaterThan(0);
    for (const k of seen) expect(k).toBe(pairKeyOf(...(k.split("|") as [string, string])));
    expect(key).toBe("npc:1|npc:2");
    expect(proposeNpcDeal(base(), "npc:1", "npc:2")).toEqual(solo);
  });
  it("never exceeds the weekly cap and never puts a houseguest in two new pacts", () => {
    for (let s = 0; s < 30; s++) {
      const out = proposeNpcDeals(base({ stream: (k) => new SeededRandom(hashSeed(`s${s}:${k}`)), bonds: flat(0.95, 1) }));
      expect(out.length).toBeLessThanOrEqual(NPC_DEALS.pairCapPerWeek);
      const all = out.flatMap((p) => p.parties);
      expect(new Set(all).size).toBe(all.length);
    }
  });
  it("proposes nothing between strangers (mutual trust under the floor)", () => {
    for (let s = 0; s < 20; s++) expect(proposeNpcDeals(base({ bonds: flat(NPC_DEALS.mutualTrustMin - 0.05), stream: (k) => new SeededRandom(hashSeed(`s${s}:${k}`)) }))).toEqual([]);
  });
  it("skips a pair the house already holds a pact for", () => {
    expect(proposeNpcDeals(base({ isTaken: () => true, bonds: flat(0.95, 1) }))).toEqual([]);
  });
  it("the tightest pacts are final-twos, the rest safety", () => {
    const hi = proposeNpcDeal(base({ bonds: flat(0.9, 1), stream: () => ({ next: () => 0 }) }), "npc:1", "npc:2");
    const lo = proposeNpcDeal(base({ bonds: flat(0.5, 1), stream: () => ({ next: () => 0 }) }), "npc:1", "npc:2");
    expect(hi?.kind).toBe("final-two");
    expect(lo?.kind).toBe("safety");
  });
  it("every pair proposal consumes exactly ONE draw (the propose roll), whatever it returns", () => {
    for (const trust of [0.1, 0.9]) {
      let n = 0;
      proposeNpcDeal(base({ bonds: flat(trust), stream: () => ({ next: () => { n++; return 0.5; } }) }), "npc:1", "npc:2");
      expect(n).toBe(1);
    }
  });
  it("a proposal is only who and what kind: no plan travels with it (the 0178 planner owns plans)", () => {
    const p = proposeNpcDeal(base({ bonds: flat(0.9, 1), stream: () => ({ next: () => 0 }) }), "npc:1", "npc:2");
    expect(Object.keys(p!).sort()).toEqual(["kind", "parties"]);
  });
  it("the kind follows the mutual trust: the more trusting the pair, the likelier a final-two", () => {
    const share = (trust: number) => {
      let f = 0, n = 0;
      for (let s = 0; s < 300; s++) { const p = proposeNpcDeal(base({ bonds: flat(trust, 1), stream: (k) => new SeededRandom(hashSeed(`k${s}:${k}`)) }), "npc:1", "npc:2"); if (p) { n++; if (p.kind === "final-two") f++; } }
      return f / Math.max(1, n);
    };
    expect(share(0.95)).toBeGreaterThan(share(0.5));
  });
});

describe("planAwareDealPush", () => {
  const deal = (status = "open", madeWeek = 1) => [{ id: "deal:1", parties: ["npc:1", "npc:2"], status, madeWeek }];
  const src = (plan?: DealPlan): PlanSource => ({ planOf: (_d, h) => (h === "npc:1" ? plan : undefined) });
  it("no plan source or no plan: the protective base stands", () => {
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), undefined)).toBe(-0.2);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src())).toBe(-0.2);
  });
  const st = (plan: DealPlan, outcome?: "carried-out" | "kept-anyway" | "overtaken"): PlanSource => ({ planOf: (_d, h) => (h === "npc:1" ? ({ ...plan, ...(outcome ? { outcome } : {}) } as DealPlan) : undefined) });
  it("keep, a retired kind, cut-final-three, flip and break-at-vote keep the protective push", () => {
    for (const plan of [{ kind: "keep" }, { kind: "a-retired-kind" }, { kind: "cut-final-three" }, { kind: "flip", moment: { week: 2, at: "vote" } }, { kind: "break-at", moment: { week: 2, at: "vote" } }] as DealPlan[])
      expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src(plan))).toBe(-0.2);
  });
  it("a break at the nominations turns it positive in THAT week only, never earlier or after", () => {
    const p: DealPlan = { kind: "break-at", moment: { week: 3, at: "nominations" } };
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src(p))).toBe(-0.2);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 3, deal(), src(p))).toBe(NPC_DEAL_PUSH.breakAtNominations);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 4, deal(), src(p))).toBe(-0.2);
  });
  it("the pact broken by that very plan this week still pushes; a pact that ended any other way does not", () => {
    const p: DealPlan = { kind: "break-at", moment: { week: 3, at: "nominations" } };
    expect(planAwareDealPush(0, "npc:1", "npc:2", 3, deal("broken"), st(p, "carried-out"))).toBe(NPC_DEAL_PUSH.breakAtNominations);
    expect(planAwareDealPush(0, "npc:1", "npc:2", 4, deal("broken"), st(p, "carried-out"))).toBe(0);
    expect(planAwareDealPush(0, "npc:1", "npc:2", 3, deal("broken"), st(p))).toBe(0);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 3, deal("kept"), st(p, "kept-anyway"))).toBe(-0.2);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 3, deal("expired"), st(p, "overtaken"))).toBe(-0.2);
  });
  it("only the holder's OWN plan counts, and only toward that deal's partner", () => {
    const p: DealPlan = { kind: "break-at", moment: { week: 2, at: "nominations" } };
    expect(planAwareDealPush(-0.2, "npc:2", "npc:1", 2, deal(), src(p))).toBe(-0.2);
    expect(planAwareDealPush(0, "npc:1", "npc:3", 2, deal(), src(p))).toBe(0);
  });
});
