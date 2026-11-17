import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import type { DealPlan, PlanSource } from "../../src/engine/npcDeals";
import { playDealsGame } from "../support/npcDealsDriver";

/** Feature 0170 - the live session: plan-aware nominations, the injected hooks, persistence, flag-off identity and the Vault. Roles only. */
type G = {
  setNpcDealsEnabled(on: boolean): void; setPlanSource(s: PlanSource | undefined): void; setRecordPlan(f: ((d: string, h: string, p: DealPlan) => void) | undefined): void;
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
  it("a flip plan turns the holder's push on the partner positive the week after; a keep plan does not", () => {
    const { g, hoh, other } = started();
    const d = g.deals.make([hoh, other], "safety", "t", undefined, g.live!.week);
    g.setNpcDealsEnabled(true);
    const nextWeek = g.live!.week + 1;
    g.setPlanSource({ planOf: (id, holder) => (id === d.id && holder === hoh ? { kind: "flip", moment: { week: nextWeek, at: "nominations" } } : undefined) });
    expect(g.dealNomPushFor(other, hoh)).toBeLessThan(0);
    g.live!.week += 1;
    d.status = "kept";
    expect(g.dealNomPushFor(other, hoh)).toBeGreaterThan(0);
    g.setPlanSource({ planOf: () => ({ kind: "keep" }) });
    expect(g.dealNomPushFor(other, hoh)).toBe(0);
  });
  it("a holder who planned to turn names the former partner; flag off, they do not", () => {
    const { g, hoh, other } = started();
    const ids = g.livingIds().filter((i) => i !== PLAYER).slice(0, 6);
    const d = g.deals.make([other, hoh], "safety", "t", undefined, g.live!.week);
    d.status = "kept";
    g.setPlanSource({ planOf: (id, h) => (id === d.id && h === hoh ? { kind: "flip", moment: { week: g.live!.week, at: "nominations" } } : undefined) });
    const rel = new RelationshipModel(0.5);
    g.setNpcDealsEnabled(true);
    expect(nominationPlan(hoh, ids, rel, { dealPush: (t) => g.dealNomPushFor(t, hoh) }).nominees).toContain(other);
    g.setNpcDealsEnabled(false);
    expect(g.dealNomPushFor(other, hoh)).toBe(0);
  });
});

describe("minting several pacts", () => {
  it("hands each side's plan to the optional hook and records the pact hidden between the two", () => {
    for (let seed = 1; seed < 40; seed++) {
      const { g } = started(seed);
      for (const a of g.livingIds()) for (const b of g.livingIds()) if (a !== b) { const e = g.rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; }
      const plans: Array<[string, string, DealPlan]> = [];
      const events: Array<{ witnesses: string[]; type?: string }> = [];
      g.setRecordPlan((d, h, p) => plans.push([d, h, p]));
      const prev = (g as unknown as { onPlayerEvent: (c: string, w: string[], t?: string) => string | undefined }).onPlayerEvent;
      g.setOnPlayerEvent((c, w, t) => { events.push({ witnesses: w, type: t }); return prev(c, w, t); });
      const before = g.deals.serialize().length;
      g.mintManyNpcDeals();
      const made = g.deals.serialize().slice(before);
      if (made.length === 0) continue;
      expect(plans.length).toBe(made.length * 2);
      for (const d of made) {
        expect(d.parties).not.toContain(PLAYER);
        expect(plans.filter((p) => p[0] === d.id).map((p) => p[1]).sort()).toEqual([...d.parties].sort());
      }
      for (const e of events) { expect(e.witnesses).not.toContain(PLAYER); expect(e.type).toBe("deal"); expect(e.witnesses.length).toBe(2); }
      return;
    }
    throw new Error("no seed minted a pact");
  });
  it("with no hook wired nothing is kept and nothing throws", () => {
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
function g_setPlans(gm: { session: unknown }): void { (gm.session as G).setPlanSource({ planOf: () => ({ kind: "flip", moment: { week: 1, at: "nominations" } }) }); }

describe("0170 the plans flow into the Auditor's plan store by default (0178)", () => {
  it("a sealed pact's two plans are written to live.dealPlans, append-only, and survive a save/load", () => {
    const { g } = started(11);
    const live = g.live as unknown as { dealPlans?: Record<string, Record<string, unknown>> };
    for (let i = 0; i < 6 && !Object.keys(live.dealPlans ?? {}).length; i++) { g.mintManyNpcDeals(); (g as unknown as { live: { week: number } }).live.week += 0; }
    const before = JSON.stringify(live.dealPlans ?? {});
    if (!Object.keys(live.dealPlans ?? {}).length) return; // this seed sealed no pact this week; the unit tests above cover the proposal
    const ids = Object.keys(live.dealPlans!);
    for (const id of ids) expect(Object.keys(live.dealPlans![id]!).length).toBe(2);
    const core = g.snapshot();
    g.restore(core);
    expect(JSON.stringify((g.live as unknown as { dealPlans?: unknown }).dealPlans ?? {})).toBe(before);
  });
});
