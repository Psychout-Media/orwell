import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { exposureHits, reopened, twistKey, DEAL_EXPOSURE } from "../../src/engine/dealExposure";
import { weighDealBreak } from "../../src/engine/dealTemptation";
import { honorWeight } from "../../src/engine/liveSeason";
import { dealTrust } from "../../src/engine/beliefConviction";

/** Feature 0186 - a deal exposed; renegotiation after a twist. Roles only. */
const told = (holder: string, subject: string, object: string): BeliefClaim =>
  ({ id: `${holder}|allied-with|${subject}|${object}|1`, holder, kind: "allied-with", subject, object, value: true, origin: "told", confidence: 0.8, week: 1 });

describe("exposure rules (pure)", () => {
  const living = ["d", "p1", "p2", "x", "y", "player"];
  const npcs = ["d", "p1", "p2", "x", "y"];
  const deals = [{ id: "a", parties: ["d", "p1"] as [string, string], kind: "final-two" as const, status: "open" }, { id: "b", parties: ["d", "p2"] as [string, string], kind: "final-two" as const, status: "open" }];
  it("hits only the partner who holds the pair, once, in a stable order", () => {
    const one = exposureHits({ deals, beliefs: { p1: [told("p1", "d", "p2")] }, living, npcs, seen: new Set() });
    expect(one.map((h) => h.key)).toEqual(["p1|d|p2"]);
    expect(exposureHits({ deals, beliefs: { p1: [told("p1", "d", "p2")] }, living, npcs, seen: new Set(["p1|d|p2"]) })).toEqual([]);
    expect(exposureHits({ deals, beliefs: {}, living, npcs, seen: new Set() })).toEqual([]);
  });
  it("a refuted belief, a safety deal and a single final two expose nothing", () => {
    expect(exposureHits({ deals, beliefs: { p1: [{ ...told("p1", "d", "p2"), refuted: true }] }, living, npcs, seen: new Set() })).toEqual([]);
    expect(exposureHits({ deals: deals.map((d) => ({ ...d, kind: "safety" as const })), beliefs: { p1: [told("p1", "d", "p2")] }, living, npcs, seen: new Set() })).toEqual([]);
    expect(exposureHits({ deals: deals.slice(0, 1), beliefs: { p1: [told("p1", "d", "p2")] }, living, npcs, seen: new Set() })).toEqual([]);
  });
  it("a public pair hits every other holder; the player is never a holder but can be the double-dealer", () => {
    const pub = exposureHits({ deals, beliefs: { x: [told("x", "d", "p2")], y: [told("y", "d", "p2")] }, living, npcs, seen: new Set() });
    expect(pub.map((h) => h.holder)).toEqual(["p1"]);
    const asPlayer = exposureHits({ deals: [{ ...deals[0]!, parties: ["player", "p1"] }, { ...deals[1]!, parties: ["player", "p2"] }], beliefs: { p1: [told("p1", "player", "p2")] }, living, npcs: npcs.filter((n) => n !== "d"), seen: new Set() });
    expect(asPlayer.map((h) => h.key)).toEqual(["p1|player|p2"]);
    const asHolder = exposureHits({ deals: [{ ...deals[0]!, parties: ["d", "player"] }, { ...deals[1]!, parties: ["d", "p2"] }], beliefs: { player: [told("player", "d", "p2")] }, living, npcs, seen: new Set() });
    expect(asHolder).toEqual([]);
  });
  it("a twist reopens a party's deals; a double eviction every open deal among the living", () => {
    const ledger = [...deals, { id: "c", parties: ["x", "y"] as [string, string], kind: "vote" as const, status: "open" }, { id: "g", parties: ["x", "gone"] as [string, string], kind: "vote" as const, status: "open" }];
    const alive = new Set(living);
    expect(reopened(ledger, { kind: "hoh", hoh: "d" }, alive).map((d) => d.id)).toEqual(["a", "b"]);
    expect(reopened(ledger, { kind: "double-eviction" }, alive).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(twistKey({ kind: "hoh", hoh: "d" }, 3)).toBe("hoh:3:d");
  });
  it("the waived floor: a twist can renegotiate where the ordinary weighing keeps", () => {
    const base = { kind: "final-two" as const, threat: 0.5, trust: 0.4, affinity: 0.4, ownPush: 0, agendaPull: 0, loyalty: 0.5, credibility: 0.9, reliableShare: 0.3, endgame: 0 as const };
    const plain = weighDealBreak(base), twist = weighDealBreak({ ...base, twist: true });
    expect(plain.pBreak).toBe(twist.pBreak);
    expect(twist.pRenegotiate).toBeGreaterThanOrEqual(plain.pRenegotiate);
    expect(weighDealBreak({ ...base, twist: false })).toEqual(plain);
  });
});

type Seam = {
  live: { playedGame?: boolean; week: number; hoh?: string; pending?: unknown; dealOffer?: { replacesDealId?: string; kind: string; from: string }; beliefs?: Record<string, BeliefClaim[]>; dealExposed?: string[]; dealReopened?: string[]; evictionOrder: string[]; twist?: { kind: string; phase: string } };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string; status: string }; all: Array<{ id: string; status: string; kind: string; parties: string[] }> };
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setDealDepthEnabled(on: boolean): void; setDealExposureEnabled(on: boolean): void; setNpcBeliefsEnabled?(on: boolean): void;
  foldExposureOvernight(): void; reopenDealsOnTwist(): void; serializeLive?: () => unknown;
};
function setup(seed: number, o: { exposure?: boolean } = {}) {
  const sb = new GameSessionRegistry().sandboxFor(`exposure-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setDealDepthEnabled(true); g.setDealExposureEnabled(o.exposure ?? true);
  g.live.playedGame = true; g.live.pending = undefined;
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  return { sb, g, npcs };
}

describe("exposure in the live adapter", () => {
  it("the partner who holds the pair loses trust in the double-dealer; the deal weight follows; once; the other partner is untouched", () => {
    const { g, npcs } = setup(11);
    const [d, p1, p2] = npcs as [string, string, string];
    g.deals.make([d, p1], "final-two", "t", undefined, g.live.week); g.deals.make([d, p2], "final-two", "t", undefined, g.live.week);
    g.live.beliefs = { ...(g.live.beliefs ?? {}), [p1]: [told(p1, d, p2)] };
    const t1 = g.rel.edge(p1, d).trust, t2 = g.rel.edge(p2, d).trust, w1 = honorWeight(dealTrust(t1));
    g.foldExposureOvernight();
    const after = g.rel.edge(p1, d).trust;
    expect(after).toBeLessThan(t1);
    expect(honorWeight(dealTrust(after))).toBeLessThan(w1);
    expect(g.rel.edge(p2, d).trust).toBe(t2);
    g.foldExposureOvernight();
    expect(g.rel.edge(p1, d).trust).toBe(after);
    expect(g.live.dealExposed).toEqual([`${p1}|${d}|${p2}`]);
  });
  it("the player as the double-dealer: the partner who learns loses trust in the player", () => {
    const { g, npcs } = setup(12);
    const [p1, p2] = npcs as [string, string];
    g.deals.make([PLAYER, p1], "final-two", "t", undefined, g.live.week); g.deals.make([PLAYER, p2], "final-two", "t", undefined, g.live.week);
    g.live.beliefs = { ...(g.live.beliefs ?? {}), [p1]: [told(p1, PLAYER, p2)] };
    const before = g.rel.edge(p1, PLAYER).trust;
    g.foldExposureOvernight();
    expect(g.rel.edge(p1, PLAYER).trust).toBeLessThan(before);
  });
  it("the same seed gives the same fold; flag off moves nothing and writes nothing", () => {
    const run = (exposure: boolean) => {
      const { g, npcs } = setup(13, { exposure });
      const [d, p1, p2] = npcs as [string, string, string];
      g.deals.make([d, p1], "final-two", "t", undefined, g.live.week); g.deals.make([d, p2], "final-two", "t", undefined, g.live.week);
      g.live.beliefs = { ...(g.live.beliefs ?? {}), [p1]: [told(p1, d, p2)] };
      const before = { ...g.rel.edge(p1, d) };
      g.foldExposureOvernight();
      return { before, after: { ...g.rel.edge(p1, d) }, state: g.live.dealExposed };
    };
    const a = run(true), b = run(true), off = run(false);
    expect(a).toEqual(b);
    expect(off.after).toEqual(off.before);
    expect(off.state).toBeUndefined();
  });
  it("is a played-game rule only", () => {
    const { g, npcs } = setup(14);
    const [d, p1, p2] = npcs as [string, string, string];
    g.deals.make([d, p1], "final-two", "t", undefined, g.live.week); g.deals.make([d, p2], "final-two", "t", undefined, g.live.week);
    g.live.beliefs = { ...(g.live.beliefs ?? {}), [p1]: [told(p1, d, p2)] };
    g.live.playedGame = false;
    const before = g.rel.edge(p1, d).trust;
    g.foldExposureOvernight();
    expect(g.rel.edge(p1, d).trust).toBe(before);
  });
  it("the exposure state round-trips a save and is in no outward view", () => {
    const { sb, g, npcs } = setup(15);
    const [d, p1, p2] = npcs as [string, string, string];
    g.deals.make([d, p1], "final-two", "t", undefined, g.live.week); g.deals.make([d, p2], "final-two", "t", undefined, g.live.week);
    g.live.beliefs = { ...(g.live.beliefs ?? {}), [p1]: [told(p1, d, p2)] };
    g.foldExposureOvernight();
    const snap = JSON.parse(JSON.stringify(g.live)) as { dealExposed?: string[] };
    expect(snap.dealExposed).toEqual([`${p1}|${d}|${p2}`]);
    const outward = JSON.stringify([(sb.session as unknown as { advanceView(x: null): unknown }).advanceView(null), sb.session.livingIds()]);
    expect(outward).not.toContain("dealExposed");
    expect(outward).not.toContain("dealReopened");
    expect(DEAL_EXPOSURE.SEVERITY).toBeGreaterThan(0);
  });
});

describe("a twist reopens deals in the live adapter", () => {
  it("a partner's HOH win does NOT turn the player's final two into a vote offer: the HOH has no vote to give (ORW-727), so the deal stands as it was", () => {
    for (let seed = 21; seed < 41; seed++) {
      const { g, npcs } = setup(seed);
      const p = npcs[0]!;
      g.live.hoh = p; g.live.dealOffer = undefined;
      const e = g.rel.edge(p, PLAYER); e.trust = 0.2; e.affinity = 0.2; e.threat = 0.9;
      const deal = g.deals.make([p, PLAYER], "final-two", "t", undefined, g.live.week);
      g.reopenDealsOnTwist();
      expect(g.live.dealOffer, "the new HOH offers no vote term").toBeUndefined();
      expect(deal.status).toBe("open");
    }
  });
  it("a double eviction turns the player's final two into a standing offer to swap from a houseguest who HAS a vote (the player may decline); once per twist", () => {
    let found = false;
    for (let seed = 21; seed < 61 && !found; seed++) {
      const { g, npcs } = setup(seed);
      const p = npcs[0]!;
      g.live.hoh = npcs[2]!; g.live.dealOffer = undefined; g.live.twist = { kind: "double-eviction", phase: "pending" } as never;
      (g.live as unknown as { nominees?: unknown }).nominees = undefined; // the nominations are still ahead, so the player is exposed to the eviction
      const e = g.rel.edge(p, PLAYER); e.trust = 0.2; e.affinity = 0.2; e.threat = 0.9;
      const deal = g.deals.make([p, PLAYER], "final-two", "t", undefined, g.live.week);
      g.reopenDealsOnTwist();
      const offer = g.live.dealOffer as { replacesDealId?: string; from: string } | undefined;
      if (offer) {
        found = true;
        expect(offer.replacesDealId).toBe(deal.id);
        expect(offer.from).toBe(p);
        expect(deal.status).toBe("open"); // the engine never accepts for the player
        const keys = [...(g.live.dealReopened ?? [])];
        g.live.dealOffer = undefined; g.reopenDealsOnTwist();
        expect(g.live.dealOffer).toBeUndefined();
        expect(g.live.dealReopened).toEqual(keys);
      }
    }
    expect(found).toBe(true);
  });
  it("two NPCs who hold a deal swap it engine-side after a double eviction", () => {
    let found = false;
    for (let seed = 21; seed < 81 && !found; seed++) {
      const { g, npcs } = setup(seed);
      const [a, b] = npcs as [string, string];
      for (const x of [a, b]) for (const y of [a, b]) if (x !== y) { const e = g.rel.edge(x, y); e.trust = 0.2; e.affinity = 0.2; e.threat = 0.9; }
      g.live.hoh ??= npcs[2]!; g.live.twist = { kind: "double-eviction", phase: "pending" };
      const deal = g.deals.make([a, b], "final-two", "t", undefined, g.live.week);
      g.reopenDealsOnTwist();
      if (deal.status === "lapsed") {
        found = true;
        expect(g.deals.all.some((d) => d.status === "open" && d.kind === "vote" && d.parties.includes(a) && d.parties.includes(b))).toBe(true);
      }
    }
    expect(found).toBe(true);
  });
  it("flag off: nothing reopens and nothing is written", () => {
    const { g, npcs } = setup(22, { exposure: false });
    const p = npcs[0]!; g.live.hoh = p;
    const e = g.rel.edge(p, PLAYER); e.trust = 0.2; e.affinity = 0.2; e.threat = 0.9;
    g.deals.make([p, PLAYER], "final-two", "t", undefined, g.live.week);
    g.reopenDealsOnTwist();
    expect(g.live.dealOffer).toBeUndefined();
    expect(g.live.dealReopened).toBeUndefined();
  });
});

describe("a twist that makes a promise impossible: the plan decides betrayal or an innocent forced break (0186 amendment)", () => {
  type PlanSeam = Seam & { live: Seam["live"] & { dealPlans?: Record<string, Record<string, { kind: string; madeWeek: number }>> }; setDealPlansEnabled(on: boolean): void };
  const hurt = (g: Seam, a: string, b: string) => { for (const [x, y] of [[a, b], [b, a]] as const) { const e = g.rel.edge(x, y); e.trust = -0.5; e.affinity = -0.5; e.threat = 1; } };
  /** One double-eviction twist over an NPC pair whose plans are `kind` for both promisers. */
  // ORW-984: one played setup per seed, saved and restored for each run (a setup is ~240 ms on CI, a restore ~10): the same game every run (fixed sandbox name), not a fresh cast per run.
  const saved = new Map<number, unknown>();
  const fromSave = (seed: number) => {
    if (!saved.has(seed)) {
      const sb0 = new GameSessionRegistry().sandboxFor(`exposure-amend-${seed}`);
      sb0.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
      sb0.session.advanceGame(); sb0.session.advanceGame();
      saved.set(seed, JSON.stringify(sb0.session.snapshot()));
    }
    const sb = new GameSessionRegistry().sandboxFor(`exposure-amend-${seed}`);
    sb.session.restore(JSON.parse(saved.get(seed) as string));
    const g = sb.session as unknown as Seam;
    g.setDealDepthEnabled(true); g.setDealExposureEnabled(true);
    g.live.playedGame = true; g.live.pending = undefined;
    return { g, npcs: sb.session.livingIds().filter((i) => i !== PLAYER) };
  };
  const run = (seed: number, kind: string, o: { plans?: boolean } = {}) => {
    const { g: g0, npcs } = fromSave(seed);
    const g = g0 as PlanSeam;
    const [a, b] = npcs as [string, string];
    hurt(g, a, b);
    g.setDealPlansEnabled(o.plans ?? true);
    g.live.hoh ??= npcs[2]!; g.live.twist = { kind: "double-eviction", phase: "pending" };
    const deal = g.deals.make([a, b], "final-two", "t", undefined, g.live.week) as { id: string; status: string; learned?: boolean; sealedBallot?: boolean; brokenBy?: string };
    g.live.dealPlans = { [deal.id]: { [a]: { kind, madeWeek: g.live.week }, [b]: { kind, madeWeek: g.live.week } } };
    const trustBefore = [g.rel.edge(a, b).trust, g.rel.edge(b, a).trust];
    g.reopenDealsOnTwist();
    return { g, deal, a, b, trustBefore, trustAfter: [g.rel.edge(a, b).trust, g.rel.edge(b, a).trust] };
  };
  const seeds = Array.from({ length: 150 }, (_, i) => 21 + i); // the betrayal search: the first seed whose roll breaks
  const universal = seeds.slice(0, 50); // ORW-984: the "never" claims (no betraying plan, the flag off) hold per seed; 50 seeds keep them under the unit lane's 30 s

  it("a faking plan uses the twist as cover: a real, quiet betrayal; the wronged party learns only through the existing gate", () => {
    let found = false;
    for (const seed of seeds) {
      const r = run(seed, "break-at");
      if (r.deal.status !== "broken") continue;
      found = true;
      expect(r.deal.brokenBy).toBeDefined();
      expect(r.deal.learned).toBe(false); // nothing learned yet: the shock waits for a pathway
      expect(r.deal.sealedBallot).toBe(true); // keeps projecting open
      const wronged = r.deal.brokenBy === r.a ? r.b : r.a, breaker = r.deal.brokenBy!;
      const t0 = JSON.stringify(r.g.rel.edge(wronged, breaker));
      expect(r.g.rel.edge(wronged, breaker).trust).toBe(r.trustBefore[wronged === r.a ? 0 : 1]); // no fold yet
      const ledger = r.g.deals as unknown as { learnOfBreak(d: unknown, s: object): boolean };
      expect(ledger.learnOfBreak(r.deal, { rel: r.g.rel, rng: new SeededRandom(1) })).toBe(true);
      expect(JSON.stringify(r.g.rel.edge(wronged, breaker))).not.toBe(t0); // the usual consequence fold, once learned
      break;
    }
    expect(found).toBe(true);
  });
  it("the same twist with no betraying plan is the forced innocent break: no betrayal, no fold", () => {
    for (const seed of universal) {
      for (const kind of ["keep", "a-retired-kind"]) {
        const r = run(seed, kind);
        expect(r.deal.status).not.toBe("broken");
        expect(r.deal.brokenBy).toBeUndefined();
        expect(r.trustAfter).toEqual(r.trustBefore);
      }
    }
  });
  it("the plan flag off: today's behaviour exactly, even with a faking plan stored", () => {
    for (const seed of universal) {
      const off = run(seed, "break-at", { plans: false }), keep = run(seed, "keep");
      expect(off.deal.status).not.toBe("broken");
      expect(off.deal.status).toBe(keep.deal.status);
      expect(off.trustAfter).toEqual(off.trustBefore);
    }
  });
  it("Vault wall: the betrayal leaves no plan, deal id or twist key in any outward view", () => {
    for (const seed of seeds) {
      const r = run(seed, "break-at");
      if (r.deal.status !== "broken") continue;
      const outward = JSON.stringify([(r.g as unknown as { advanceView(x: null): unknown }).advanceView(null)]);
      expect(outward).not.toContain("break-at");
      expect(outward).not.toContain("dealPlans");
      expect(outward).not.toContain("deal-twist-betray");
      return;
    }
    throw new Error("no seed produced a betrayal");
  });
});
