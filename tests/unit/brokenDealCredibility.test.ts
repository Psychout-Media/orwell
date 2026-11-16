import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { brokenDealClaimId, brokenDealLieConfidence, DEAL_BREAK_CREDIBILITY } from "../../src/engine/dealCredibility";
import { credibility } from "../../src/engine/credibility";
import { breakSeverityScale, type Deal } from "../../src/engine/deals";

/** ORW-545 - a broken formal deal counts against the breaker's credibility like a caught lie; a kept one never does. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Internals = {
  presence: Map<EntityId, string> | null;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setNpcMemoryEnabled(on: boolean): void;
  setDealsWitnessesEnabled(on: boolean): void;
  reconcileDeals(a: { actor: EntityId; kind: "nominate"; targets: EntityId[] }): void;
  writeDealBreakLie(holder: EntityId, breaker: EntityId, deal: Deal, role: "wronged" | "witness"): void;
  deals: { all?: Deal[]; open(): Deal[] };
};

function table() {
  const s = new GameSessionRegistry().sandboxFor("bdc-1").session;
  s.createCharacter({ playerName: "The Player", seed: 7 });
  for (let i = 0; i < 3; i++) s.advanceGame();
  const g = s as unknown as Internals;
  g.setNpcMemoryEnabled(true);
  g.setDealsWitnessesEnabled(true);
  const [partner, w1, w2, outsider, third] = s.livingIds().filter((id) => id !== PLAYER);
  const seat = () => { g.presence = new Map<EntityId, string>([[PLAYER, "kitchen"], [partner!, "kitchen"], [w1!, "kitchen"], [w2!, "kitchen"], [outsider!, "backyard"], [third!, "backyard"]]); };
  seat();
  for (const id of [partner!, w1!, w2!]) for (const o of [PLAYER, partner!, w1!, w2!]) if (id !== o) { const e = g.rel.edge(id, o); e.trust = 0.05; e.affinity = 0.05; }
  { const e = g.rel.edge(partner!, PLAYER); e.trust = 0.9; e.affinity = 0.9; e.threat = 0; }
  s.noteMessage({ messageId: "m-0" });
  seat();
  return { s, g, partner: partner!, w1: w1!, w2: w2!, outsider: outsider!, third: third! };
}

describe("a broken deal lowers the breaker's credibility", () => {
  it("the wronged party believes the breaker less; a witness less than that; an absent houseguest not at all", () => {
    const t = table();
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe" });
    for (const id of [t.partner, t.w1, t.w2, t.outsider]) expect(t.s.credibilityOf(id, PLAYER)).toBe(1);
    t.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [t.partner] });
    const wronged = t.s.credibilityOf(t.partner, PLAYER), witness = t.s.credibilityOf(t.w1, PLAYER);
    expect(wronged).toBeLessThan(1);
    expect(witness).toBeLessThan(1);
    expect(witness).toBeGreaterThan(wronged);
    expect(t.s.credibilityOf(t.outsider, PLAYER)).toBe(1);
    expect(t.s.credibilityOf(t.partner, t.w1)).toBe(1); // only the breaker pays
  });
  it("a deal that is kept (the partner is spared) lowers nothing", () => {
    const t = table();
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe" });
    t.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [t.third] });
    for (const id of [t.partner, t.w1, t.w2]) expect(t.s.credibilityOf(id, PLAYER)).toBe(1);
  });
  it("counting the same break again changes nothing", () => {
    const t = table();
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe" });
    t.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [t.partner] });
    const before = [t.partner, t.w1].map((id) => t.s.credibilityOf(id, PLAYER));
    const deal = (t.g as unknown as { deals: { serialize(): Deal[] } }).deals.serialize()[0]!;
    t.g.writeDealBreakLie(t.partner, PLAYER, deal, "wronged");
    t.g.writeDealBreakLie(t.w1, PLAYER, deal, "witness");
    expect([t.partner, t.w1].map((id) => t.s.credibilityOf(id, PLAYER))).toEqual(before);
  });
  it("with the lies-caught layer off nothing is written (byte-identical)", () => {
    const t = table();
    (t.s as unknown as { setLiesCaughtEnabled(on: boolean): void }).setLiesCaughtEnabled(false);
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe" });
    t.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [t.partner] });
    expect(t.s.credibilityOf(t.partner, PLAYER)).toBe(1);
  });
});

describe("the pure part", () => {
  const deal = { id: "deal:1", parties: ["a", "b"], kind: "safety", terms: "", condition: { protect: "b", promisors: ["a"] }, status: "broken" } as unknown as Deal;
  it("severity follows breakSeverityScale and witnesses weigh the existing factor, clamped to 0..1", () => {
    expect(brokenDealLieConfidence(deal, 1, "wronged")).toBeCloseTo(DEAL_BREAK_CREDIBILITY.wrongedConfidence, 9);
    expect(brokenDealLieConfidence(deal, 1, "witness")).toBeCloseTo(DEAL_BREAK_CREDIBILITY.wrongedConfidence * DEAL_BREAK_CREDIBILITY.witnessFactor, 9);
    const vague = { ...deal, vague: true } as Deal;
    expect(brokenDealLieConfidence(vague, 1, "wronged")).toBeCloseTo(0.8 * breakSeverityScale(vague, 1), 9);
    const long = { ...deal, expiresWeek: 99 } as Deal;
    expect(brokenDealLieConfidence(long, 1, "wronged")).toBeLessThanOrEqual(1);
    expect(brokenDealLieConfidence(long, 1, "wronged")).toBeGreaterThanOrEqual(brokenDealLieConfidence(deal, 1, "wronged"));
  });
  it("the claim id is per (holder, breaker, deal) and a break never raises credibility", () => {
    expect(brokenDealClaimId("h", "b", deal)).toBe(brokenDealClaimId("h", "b", deal));
    expect(brokenDealClaimId("h", "b", deal)).not.toBe(brokenDealClaimId("h2", "b", deal));
    const e = { speaker: "b" as EntityId, week: 1 };
    const base = credibility([], 0, 1);
    for (const role of ["wronged", "witness"] as const) expect(credibility([{ ...e, severity: brokenDealLieConfidence(deal, 1, role) }], 0, 1)).toBeLessThanOrEqual(base);
  });
});
