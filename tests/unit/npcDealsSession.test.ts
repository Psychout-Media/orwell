import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import type { DealPlan, PlanSource } from "../../src/engine/npcDeals";
import { playDealsGame } from "../support/npcDealsDriver";

/** Feature 0170 - the live session: plan-aware nominations, the injected hooks, persistence, flag-off identity and the Vault. Roles only. */
type G = {
  setNpcDealsEnabled(on: boolean): void; setPlanSource(s: PlanSource | undefined): void;
  dealNomPushFor(t: string, h: string): number; mintManyNpcDeals(): void; setOnPlayerEvent(f: (c: string, w: string[], t?: string) => string | undefined): void;
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string; status: string }; serialize(): Array<{ id: string; status: string; kind: string; parties: string[]; madeWeek?: number }>; npcOnly(): unknown[] };
  rel: { edge(a: string, b: string): { trust: number; affinity: number } };
  live?: { week: number };
  livingIds(): string[]; snapshot(): unknown; restore(c: unknown): void;
};
function started(seed = 7) {
  const sb = new GameSessionRegistry().sandboxFor(`npcdeals-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  const [hoh, other, third] = g.livingIds().filter((i) => i !== PLAYER) as [string, string, string];
  return { sb, g, hoh, other, third };
}

describe("plan-aware nomination push (flag ORWELL_NPC_DEALS)", () => {
  it("with no plan source the push is exactly the protective one", () => {
    const { g, hoh, other } = started();
    g.deals.make([hoh, other], "safety", "t", undefined, g.live!.week);
    const off = (g.setNpcDealsEnabled(false), g.dealNomPushFor(other, hoh));
    g.setNpcDealsEnabled(true);
    expect(g.dealNomPushFor(other, hoh)).toBe(off);
    expect(off).toBeLessThan(0);
  });
  it("a plan to break at the nominations turns the holder's push on the partner positive in that week only; a keep plan does not", () => {
    const { g, hoh, other } = started();
    const d = g.deals.make([hoh, other], "safety", "t", undefined, g.live!.week);
    g.setNpcDealsEnabled(true);
    const week = g.live!.week;
    g.setPlanSource({ planOf: (id, holder) => (id === d.id && holder === hoh ? { kind: "break-at", moment: { week: week + 1, at: "nominations" } } : undefined) });
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
    g.live!.week += 1;
    expect(g.dealNomPushFor(other, hoh)).toBeGreaterThan(0);
    g.live!.week += 1;
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0); // the end week: no lean after the moment has passed
    g.live!.week -= 1;
    g.setPlanSource({ planOf: () => ({ kind: "keep" }) });
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
  });
  it("a holder who planned to turn names the former partner; flag off, they do not", () => {
    const { g, hoh, other } = started();
    const ids = g.livingIds().filter((i) => i !== PLAYER).slice(0, 6);
    const d = g.deals.make([other, hoh], "safety", "t", undefined, g.live!.week);
    g.setPlanSource({ planOf: (id, h) => (id === d.id && h === hoh ? { kind: "break-at", moment: { week: g.live!.week, at: "nominations" } } : undefined) });
    const rel = new RelationshipModel(0.5);
    g.setNpcDealsEnabled(true);
    expect(nominationPlan(hoh, ids, rel, { dealPush: (t) => g.dealNomPushFor(t, hoh) }).nominees).toContain(other);
    g.setNpcDealsEnabled(false);
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0); // flag off: today's protective push for the still-open pact (the plan is ignored)
  });
});

describe("minting several pacts", () => {
  it("records the pact as an ordinary hidden ledger deal between two NPCs, with no plan of its own", () => {
    for (let seed = 1; seed < 40; seed++) {
      const { g } = started(seed);
      for (const a of g.livingIds()) for (const b of g.livingIds()) if (a !== b) { const e = g.rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; }
      const events: Array<{ witnesses: string[]; type?: string }> = [];
      const prev = (g as unknown as { onPlayerEvent: (c: string, w: string[], t?: string) => string | undefined }).onPlayerEvent;
      g.setOnPlayerEvent((c, w, t) => { events.push({ witnesses: w, type: t }); return prev(c, w, t); });
      const before = g.deals.serialize().length;
      g.mintManyNpcDeals();
      const made = g.deals.serialize().slice(before);
      if (made.length === 0) continue;
      for (const d of made) expect(d.parties).not.toContain(PLAYER);
      expect((g.live as unknown as { dealPlans?: unknown }).dealPlans).toBeUndefined(); // minting writes no plan: main's planner does, in a played game
      for (const e of events) { expect(e.witnesses).not.toContain(PLAYER); expect(e.type).toBe("deal"); expect(e.witnesses.length).toBe(2); }
      return;
    }
    throw new Error("no seed minted a pact");
  });
  it("never throws", () => {
    const { g } = started(3);
    for (const a of g.livingIds()) for (const b of g.livingIds()) if (a !== b) { const e = g.rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; }
    expect(() => g.mintManyNpcDeals()).not.toThrow();
  });
  it("is deterministic: the same seed mints the same pacts", () => {
    const run = () => { const { g } = started(5); for (const a of g.livingIds()) for (const b of g.livingIds()) if (a !== b) { const e = g.rel.edge(a, b); e.trust = 0.9; e.affinity = 0.9; } g.mintManyNpcDeals(); return JSON.stringify(g.deals.serialize()); };
    expect(run()).toBe(run());
  });
  it("is the only thing the stream touches: minting leaves every relationship edge as it was", () => {
    const { g } = started(5);
    const snap = () => JSON.stringify((g as unknown as { rel: { serialize(): unknown } }).rel.serialize());
    const before = snap(); g.mintManyNpcDeals();
    expect(snap()).toBe(before);
  });
});

describe("a played season", () => {
  it("flag off: no pact is minted through the new door", async () => {
    const prev = process.env.ORWELL_NPC_DEALS; process.env.ORWELL_NPC_DEALS = "0";
    try {
      const gm = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: "npcdeals-off" });
      const ev = gm.reg.sandboxFor(gm.user).engine.events.queryAll().map((e) => String(e.content));
      expect(ev.some((c) => /settle a quiet/.test(c))).toBe(false);
    } finally { if (prev === undefined) delete process.env.ORWELL_NPC_DEALS; else process.env.ORWELL_NPC_DEALS = prev; }
  }, 120000);
  it("flag on: save and load keep every deal; a later save never holds fewer", async () => {
    const a = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: `npcdeals-on-${Math.random()}` });
    const first = a.session.deals.serialize();
    expect(first.length).toBeGreaterThan(0);
    const snap1 = JSON.parse(JSON.stringify(a.session.snapshot())) as { deals: Array<{ id: string }> };
    const copy = new GameSessionRegistry().sandboxFor(`npcdeals-copy-${Math.random()}`).session as unknown as G;
    copy.restore(snap1);
    expect(JSON.stringify(copy.deals.serialize())).toBe(JSON.stringify(first));
    await a.more(700, (x) => x.week() >= 5);
    const snap2 = JSON.parse(JSON.stringify(a.session.snapshot())) as { deals: Array<{ id: string }> };
    const ids2 = new Set(snap2.deals.map((d) => d.id));
    for (const d of snap1.deals) expect(ids2.has(d.id)).toBe(true);
    expect(snap2.deals.length).toBeGreaterThanOrEqual(snap1.deals.length);
  }, 240000);
  it("no player or admin view shows the pact, a plan or a trust figure", async () => {
    const gm = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: "npcdeals-vault" });
    expect(gm.session.deals.npcOnly().length).toBeGreaterThan(0);
    g_setPlans(gm);
    const player = gm.reg.resolver()("player", gm.user), admin = gm.reg.resolver()("admin", gm.user);
    const blob = JSON.stringify([
      await player.callTool("getGameState", {}), await player.callTool("gameStatus", {}), await player.callTool("getMomentPrompt", {}),
      await player.callTool("seasonRecap", {}), await player.callTool("dailyRecap", {}), await admin.callTool("inspectNonVaultState", {}),
    ]);
    for (const needle of ["settle a quiet", "quiet pact sealed", "planOf", "\"flip\"", "cut-final-three", "break-at", "this-week"]) expect(blob.includes(needle), needle).toBe(false);
  }, 120000);
});
function g_setPlans(gm: { session: unknown }): void { (gm.session as G).setPlanSource({ planOf: () => ({ kind: "break-at", moment: { week: 1, at: "nominations" } }) }); }

type Played = { week: number; beat: string; playedGame?: boolean; dealPlans?: Record<string, Record<string, { kind: string; moment?: { week: number; at: string }; madeWeek: number; outcome?: string }>> };
type PG = G & { planAndCarryOutDeals(): void };
/** A played-game pact between the HOH and one other NPC, sealed through mintManyNpcDeals' ledger path (only that pair is trusting), planned by main's planner. */
function playedPact() {
  for (let seed = 1; seed < 80; seed++) {
    const { g, hoh, other } = started(seed);
    const live = g.live as unknown as Played;
    const rel = g.rel as unknown as { edge(a: string, b: string): { trust: number; affinity: number } };
    for (const a of g.livingIds()) for (const b of g.livingIds()) if (a !== b && !(a === hoh && b === other) && !(a === other && b === hoh)) { const e = rel.edge(a, b); e.trust = 0.1; e.affinity = 0.1; }
    for (const [a, b] of [[hoh, other], [other, hoh]] as const) { const e = rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; }
    g.mintManyNpcDeals();
    const d = g.deals.serialize().find((x) => x.parties.includes(hoh) && x.parties.includes(other) && x.madeWeek === live.week);
    if (!d) continue;
    live.playedGame = true; live.beat = "hoh-competition"; // played, and not yet at any plan's moment
    (g as PG).planAndCarryOutDeals(); // main's planner gives each promisor their secret plan
    return { g: g as PG, hoh, other, live, id: d.id };
  }
  throw new Error("no seed sealed the pact");
}
const statusOf = (g: G, id: string) => g.deals.serialize().find((d) => d.id === id)!.status;

describe("0170 the pact is planned by main's planner and the push reads that plan (PLAYED path, real carry-out)", () => {
  it("main plans a pact the module sealed, for every promisor, like any deal", () => {
    const { live, id, hoh, other } = playedPact();
    expect(Object.keys(live.dealPlans![id]!).sort()).toEqual([hoh, other].sort());
  });
  it("a break-at-nominations plan for the HOH: the carry-out breaks the pact, and the push on the former partner is positive THAT week only", () => {
    const { g, hoh, other, live, id } = playedPact();
    live.dealPlans![id]![hoh] = { kind: "break-at", moment: { week: live.week, at: "nominations" }, madeWeek: live.week };
    live.dealPlans![id]![other] = { kind: "keep", madeWeek: live.week };
    live.beat = "nominations";
    g.planAndCarryOutDeals(); // runs before the nominations push is read (advanceOneBeat)
    expect(statusOf(g, id)).toBe("broken");
    expect(live.dealPlans![id]![hoh]!.outcome).toBe("carried-out");
    expect(g.dealNomPushFor(other, hoh)).toBeGreaterThan(0);
    live.week += 1;
    expect(g.dealNomPushFor(other, hoh)).not.toBeGreaterThan(0);
  });
  it("a kept pact keeps the protective push, and so does a pact whose plan is not a nominations break", () => {
    for (const plan of [{ kind: "keep" }, { kind: "break-at", moment: { week: 99, at: "vote" } }, { kind: "this-week", moment: { week: 99, at: "nominations" } }]) {
      const { g, hoh, other, live, id } = playedPact();
      live.dealPlans![id]![hoh] = { ...plan, madeWeek: live.week };
      live.dealPlans![id]![other] = { kind: "keep", madeWeek: live.week };
      live.beat = "nominations";
      g.planAndCarryOutDeals();
      expect(statusOf(g, id)).toBe("open");
      expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
    }
  });
  it("headless (not a played game): main's planner runs nothing, so no plan exists and the push is today's protective one", () => {
    const { g, hoh, other } = started(9);
    g.deals.make([hoh, other], "safety", "t", undefined, g.live!.week);
    (g as PG).planAndCarryOutDeals();
    expect((g.live as unknown as Played).dealPlans).toBeUndefined();
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
  });
  it("flag off: a played game's push is the protective one even with a nominations-break plan standing", () => {
    const { g, hoh, other, live, id } = playedPact();
    live.dealPlans![id]![hoh] = { kind: "break-at", moment: { week: live.week, at: "nominations" }, madeWeek: live.week };
    g.setNpcDealsEnabled(false);
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
  });
});
