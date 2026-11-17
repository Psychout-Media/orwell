import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { proposeNpcDeal, proposeNpcDeals, breakChance, planFor, planAwareDealPush, pairKeyOf, type NpcDealInputs, type PlanSource, type DealPlan } from "../../src/engine/npcDeals";
import { NPC_DEALS } from "../../src/engine/npcDealConstants";
import { NPC_DEAL_PUSH } from "../../src/engine/dealNomConstants";

/** Feature 0170 - the pure NPC-deal proposal and the plan-aware push. Roles only (NPC ids are opaque). */
const ids = Array.from({ length: 10 }, (_, i) => `npc:${i + 1}`);
const flat = (trust: number, warmth = 0.5) => ({ bond: () => ({ trust, warmth, strength: 0.5 }) });
const base = (over: Partial<NpcDealInputs> = {}): NpcDealInputs => ({
  week: 1, npcs: ids, bonds: flat(0.8), isTaken: () => false, dealsMade: () => 0, loyaltyOf: () => 0.5, breakLean: 1,
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
  it("each side holds its own plan and the two can differ", () => {
    let differ = false;
    for (let s = 0; s < 200 && !differ; s++) {
      const p = proposeNpcDeal(base({ bonds: flat(0.8, 1), stream: (k) => new SeededRandom(hashSeed(`d${s}:${k}`)) }), "npc:1", "npc:2");
      if (p && JSON.stringify(p.planA) !== JSON.stringify(p.planB)) differ = true;
    }
    expect(differ).toBe(true);
  });
  it("every pair proposal consumes exactly five draws, whatever it returns", () => {
    for (const trust of [0.1, 0.9]) {
      let n = 0;
      proposeNpcDeal(base({ bonds: flat(trust), stream: () => ({ next: () => { n++; return 0.5; } }) }), "npc:1", "npc:2");
      expect(n).toBe(5);
    }
  });
});

describe("the plan decision", () => {
  it("a holder who trusts the partner less leans harder to break", () => {
    expect(breakChance(0.2, 0.5, 0, 1)).toBeGreaterThan(breakChance(0.9, 0.5, 0, 1));
  });
  it("a less loyal holder leans harder to break", () => {
    expect(breakChance(0.6, 0.1, 0, 1)).toBeGreaterThan(breakChance(0.6, 0.9, 0, 1));
  });
  it("a prolific dealmaker leans harder to break (no cap)", () => {
    expect(breakChance(0.6, 0.5, 8, 1)).toBeGreaterThan(breakChance(0.6, 0.5, 0, 1));
  });
  it("the season culture scales the lean", () => {
    expect(breakChance(0.4, 0.5, 2, 1.3)).toBeGreaterThan(breakChance(0.4, 0.5, 2, 0.8));
  });
  it("a plan to break is one of the break plans; a plan to keep is keep or this-week", () => {
    expect(planFor("safety", 2, 1, 0, 0)).toEqual({ kind: "break-at", moment: { week: 2, at: "nominations" } });
    expect(planFor("safety", 2, 1, 0, 0.99)).toEqual({ kind: "break-at", moment: { week: 2, at: "vote" } });
    expect(planFor("final-two", 2, 1, 0, 0).kind).toBe("cut-final-three");
    expect(planFor("final-two", 2, 1, 0, 0.5)).toEqual({ kind: "break-at", moment: { week: 3, at: "nominations" } });
    expect(planFor("safety", 2, 0, 0.5, 0.99)).toEqual({ kind: "keep" });
    // main's 0178 semantics: the honest "this-week" plan carries the moment AFTER the pact has expired (next week's nominations), so its carry-out finds the deal expired and keeps it
    expect(planFor("safety", 2, 0, 0.5, 0)).toEqual({ kind: "this-week", moment: { week: 3, at: "nominations" } });
    expect(planFor("final-two", 2, 0, 0.5, 0)).toEqual({ kind: "keep" });
  });
  it("over many seeds the share of break plans follows the person, not a flat rate", () => {
    const share = (trust: number) => {
      let b = 0, n = 0;
      for (let s = 0; s < 400; s++) {
        const p = proposeNpcDeal(base({ bonds: flat(trust, 1), stream: (k) => new SeededRandom(hashSeed(`m${s}:${k}`)) }), "npc:1", "npc:2");
        if (p) { n++; if (p.planA.kind !== "keep" && p.planA.kind !== "this-week") b++; }
      }
      return b / Math.max(1, n);
    };
    expect(share(0.5)).toBeGreaterThan(share(0.95));
  });
});

describe("planAwareDealPush", () => {
  const deal = (status = "open", madeWeek = 1) => [{ id: "deal:1", parties: ["npc:1", "npc:2"], status, madeWeek }];
  const src = (plan?: DealPlan): PlanSource => ({ planOf: (_d, h) => (h === "npc:1" ? plan : undefined) });
  it("no plan source or no plan: the protective base stands", () => {
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), undefined)).toBe(-0.2);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src())).toBe(-0.2);
  });
  it("keep, this-week, cut-final-three and break-at-vote keep the protective push", () => {
    for (const plan of [{ kind: "keep" }, { kind: "this-week" }, { kind: "cut-final-three" }, { kind: "break-at", moment: { week: 2, at: "vote" } }] as DealPlan[])
      expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src(plan))).toBe(-0.2);
  });
  it("a plan never produces a flip (main carries that out only at a vote on a vote deal): planFor yields keep, this-week, break-at or cut-final-three", () => {
    const kinds = new Set<string>();
    for (const kind of ["safety", "final-two"] as const) for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { kinds.add(planFor(kind, 2, 0.5, i / 10, j / 10).kind); }
    expect([...kinds].sort()).toEqual(["break-at", "cut-final-three", "keep", "this-week"]);
  });
  it("the honest this-week plan is never due while its pact is open (its moment is after the pact has expired)", () => {
    const p = planFor("safety", 2, 0, 0.5, 0);
    expect(p.kind).toBe("this-week");
    expect(p.moment!.week).toBeGreaterThan(2);
  });
  it("a break at the nominations turns it positive in THAT week only (the carry-out breaks the pact there) and only while the pact is open", () => {
    const p: DealPlan = { kind: "break-at", moment: { week: 3, at: "nominations" } };
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 2, deal(), src(p))).toBe(-0.2);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 3, deal(), src(p))).toBe(NPC_DEAL_PUSH.breakAtNominations);
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 4, deal(), src(p))).toBe(-0.2); // the end week: no lean after the moment has passed
    expect(planAwareDealPush(-0.2, "npc:1", "npc:2", 3, deal("kept"), src(p))).toBe(-0.2); // an expired/kept pact no longer pushes
  });
  it("only the holder's OWN plan counts, and only toward that deal's partner", () => {
    const p: DealPlan = { kind: "break-at", moment: { week: 2, at: "nominations" } };
    expect(planAwareDealPush(-0.2, "npc:2", "npc:1", 2, deal(), src(p))).toBe(-0.2);
    expect(planAwareDealPush(0, "npc:1", "npc:3", 2, deal(), src(p))).toBe(0);
  });
  it("a deal already broken contributes nothing", () => {
    expect(planAwareDealPush(0, "npc:1", "npc:2", 2, deal("broken"), src({ kind: "break-at", moment: { week: 2, at: "nominations" } }))).toBe(0);
  });
});

// 0178 shared dials (the Coordinator's order: one model, not two): the break chance's deal-count lean and base readiness ARE the Auditor's FAKING dials.
import { FAKING, fakingLean } from "../../src/engine/dealPlans";
describe("0170 the break chance reads the shared faking dials (0178)", () => {
  it("each past pact adds exactly FAKING.perPastDeal (times the culture lean) while uncapped below the clamp", () => {
    const base = breakChance(0.9, 0.9, 1, 1), more = breakChance(0.9, 0.9, 3, 1);
    expect(more - base).toBeCloseTo(2 * FAKING.perPastDeal, 10);
  });
  it("the chance contains fakingLean(made, 1 - loyalty) and nothing of the old local base or per-deal weight", () => {
    const loyalty = 0.8, made = 2;
    const expected = Math.min(1, NPC_DEALS.plan.lowTrustWeight * Math.max(0, NPC_DEALS.plan.trustMid - 0.9) + NPC_DEALS.plan.disloyalWeight * Math.max(0, NPC_DEALS.plan.loyaltyMid - loyalty) + fakingLean(made, 1 - loyalty));
    expect(breakChance(0.9, loyalty, made, 1)).toBeCloseTo(expected, 10);
    expect(Object.keys(NPC_DEALS.plan)).not.toContain("breakBase");
    expect(Object.keys(NPC_DEALS.plan)).not.toContain("dealCountWeight");
  });
});
