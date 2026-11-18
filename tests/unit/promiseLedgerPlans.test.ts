import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import { isLedgerPlanKey, ledgerPlanKey, planSourceOf, recordPlan, type PlanStore, type StoredPlan } from "../../src/engine/dealPlans";
import { PROMISE_VETO_LEAN, ledgerPlanRetroRows, termPlanDealKind } from "../../src/engine/promiseTerms";
import type { OpenLedger } from "../../src/engine/openLedger";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-586 / 0187 slice 5 - an NPC's improvised termed promise gets a SECRET PLAN the way a deal does (`ledgerPlanKey` in the one plan store), and the slice 4 readers (the assurance reads, the veto and final-two reads)
 * read it through `dealPlanSource().planOf`. Real engine, no model. Roles only: the promiser, the promisee, a third houseguest.
 */
type G = {
  live: { playedGame?: boolean; week: number; active: string[]; dealPlans?: PlanStore; beliefs?: BeliefStore };
  openLedger: OpenLedger;
  recordPromiseTerm(r: unknown): { accepted: boolean; reason?: string; entryId?: string };
  assuranceProtects(t: string, h: string): boolean;
  assuranceVoteFor(n: string, v: string): number;
  assuranceNominated(h: string, n: string, among?: readonly string[]): void;
  assuranceVotedOut(v: string, n: string, among?: readonly string[]): void;
  ctx(): { promiseVetoFor?: (n: string, h: string) => number; promiseFinalTwoFor?: (h: string, r: readonly string[]) => string | undefined };
  rel: { edge(a: string, b: string): { trust: number; threat: number } };
  dealPlanSource(): { planOf(k: string, h: string): { kind: string } | undefined };
  setDealPlansEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void;
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void; setAdvanceGateEnabled(on: boolean): void;
  movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
  noteMessage(m: unknown): void;
  openLedgerHere(): unknown[];
  snapshot(): SessionSnapshot;
};
function started(opts: { plans?: boolean } = {}) {
  const sb = new GameSessionRegistry().sandboxFor(`plp-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  sb.session.setAssurancesEnabled(true);
  g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true); g.setLiesCaughtEnabled(true);
  g.setPromiseTermsEnabled(true); g.setDealPlansEnabled(opts.plans ?? true);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  const [promiser, promisee, third] = present as [string, string, string];
  return { sb, g, promiser, promisee, third };
}
/** Stand in for the seeded plan roll: set the promiser's plan for an entry (write-once store, so the natural one is removed first). */
function setPlan(g: G, entryId: string, holder: string, plan: Omit<StoredPlan, "madeWeek">): void {
  const store = (g.live.dealPlans ??= {});
  delete store[ledgerPlanKey(entryId)];
  recordPlan(store, ledgerPlanKey(entryId), holder, plan, g.live.week);
}
const lied = (g: G, holder: string) => claimsOf(g.live.beliefs ?? {}, holder).filter((c) => c.kind === "lied-to-me");
const entry = (g: G, id: string) => g.openLedger.entries.find((e) => e.id === id)!;

describe("the ledger plan key lives in its own namespace", () => {
  it("a ledger key never changes a deal's plan read", () => {
    const withoutLedger: PlanStore = {}; recordPlan(withoutLedger, "deal:1", "holder", { kind: "break-at", moment: { week: 2, at: "nominations" } }, 1);
    const withLedger: PlanStore = JSON.parse(JSON.stringify(withoutLedger));
    recordPlan(withLedger, ledgerPlanKey("deal:1"), "holder", { kind: "keep" }, 1); // even an entry id that spells like a deal id
    const a = planSourceOf(() => withoutLedger), b = planSourceOf(() => withLedger);
    expect(b.planOf("deal:1", "holder")).toEqual(a.planOf("deal:1", "holder"));
    expect(b.planOf("deal:1", "other")).toBeUndefined();
    expect(isLedgerPlanKey(ledgerPlanKey("x"))).toBe(true);
    expect(isLedgerPlanKey("deal:1")).toBe(false);
  });
});

describe("an NPC's improvised promise gets a plan", () => {
  it("one plan per termed promise by an NPC, write-once, under its own key; none for the player, none for share-info", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    const plan = g.dealPlanSource().planOf(ledgerPlanKey(r.entryId!), promiser);
    expect(plan).toBeDefined();
    const before = JSON.stringify(g.live.dealPlans);
    expect(recordPlan(g.live.dealPlans!, ledgerPlanKey(r.entryId!), promiser, { kind: "keep" }, 9)).toBe(false); // write-once
    expect(JSON.stringify(g.live.dealPlans)).toBe(before);
    const p = g.recordPromiseTerm({ by: PLAYER, to: promisee, what: "no-nominate" });
    expect(g.dealPlanSource().planOf(ledgerPlanKey(p.entryId!), PLAYER)).toBeUndefined();
    const s = g.recordPromiseTerm({ by: promiser, to: promisee, what: "share-info" });
    expect(g.dealPlanSource().planOf(ledgerPlanKey(s.entryId!), promiser)).toBeUndefined();
    expect(termPlanDealKind("share-info")).toBeUndefined();
  });
  it("the plan decision is a keyed side stream: the same game gives the same plan, and drawing it never moves another read", () => {
    const a = started(), b = started();
    const ra = a.g.recordPromiseTerm({ by: a.promiser, to: a.promisee, what: "use-veto-on" });
    const rb = b.g.recordPromiseTerm({ by: b.promiser, to: b.promisee, what: "use-veto-on" });
    expect(a.g.dealPlanSource().planOf(ledgerPlanKey(ra.entryId!), a.promiser)).toEqual(b.g.dealPlanSource().planOf(ledgerPlanKey(rb.entryId!), b.promiser));
  });
});

describe("a faking promiser breaks at the planned moment; a keep-plan promiser keeps", () => {
  it("no-nominate: a break-at plan due at the nominations breaks it, folded ONCE through foldBrokenPromise; a keep plan keeps it", () => {
    const f = started();
    const r = f.g.recordPromiseTerm({ by: f.promiser, to: f.promisee, what: "no-nominate" });
    f.g.rel.edge(f.promiser, f.promisee).threat = 0;
    setPlan(f.g, r.entryId!, f.promiser, { kind: "break-at", moment: { week: f.g.live.week, at: "nominations" } });
    expect(f.g.assuranceProtects(f.promisee, f.promiser)).toBe(false); // the plan says break now
    const t0 = f.g.rel.edge(f.promisee, f.promiser).trust;
    f.g.assuranceNominated(f.promiser, f.promisee);
    f.g.assuranceNominated(f.promiser, f.promisee);
    expect(entry(f.g, r.entryId!).status).toBe("broken");
    expect(f.g.rel.edge(f.promisee, f.promiser).trust).toBeCloseTo(Math.max(0, t0 - 0.12), 10);
    expect(lied(f.g, f.promisee).filter((c) => c.subject === f.promiser)).toHaveLength(1);

    const k = started();
    const rk = k.g.recordPromiseTerm({ by: k.promiser, to: k.promisee, what: "no-nominate" });
    k.g.rel.edge(k.promiser, k.promisee).threat = 0;
    setPlan(k.g, rk.entryId!, k.promiser, { kind: "keep" });
    expect(k.g.assuranceProtects(k.promisee, k.promiser)).toBe(true);
  });
  it("a plan whose moment has not come yet keeps for now", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    g.rel.edge(promiser, promisee).threat = 0;
    setPlan(g, r.entryId!, promiser, { kind: "break-at", moment: { week: g.live.week + 1, at: "nominations" } });
    expect(g.assuranceProtects(promisee, promiser)).toBe(true);
  });
  it("a plan overrides the row's own sincerity roll: a keep plan keeps a promise the older roll would have called a lie", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    g.rel.edge(promiser, promisee).threat = 0.05;
    (g.live as unknown as { assurances: { items: Array<{ sincerity: number }> } }).assurances.items.forEach((a) => { a.sincerity = 0.01; });
    setPlan(g, r.entryId!, promiser, { kind: "keep" });
    expect(g.assuranceProtects(promisee, promiser)).toBe(true);
  });
  it("use-veto-on: a due betrayal gives the save no lean and the veto folds it broken once; a keep plan leans", () => {
    const f = started();
    const r = f.g.recordPromiseTerm({ by: f.promiser, to: f.promisee, what: "use-veto-on" });
    f.g.rel.edge(f.promiser, f.promisee).threat = 0;
    setPlan(f.g, r.entryId!, f.promiser, { kind: "break-at", moment: { week: f.g.live.week, at: "nominations" } });
    expect(f.g.ctx().promiseVetoFor!(f.promisee, f.promiser)).toBe(0);
    const k = started();
    const rk = k.g.recordPromiseTerm({ by: k.promiser, to: k.promisee, what: "use-veto-on" });
    k.g.rel.edge(k.promiser, k.promisee).threat = 0;
    setPlan(k.g, rk.entryId!, k.promiser, { kind: "keep" });
    expect(k.g.ctx().promiseVetoFor!(k.promisee, k.promiser)).toBe(PROMISE_VETO_LEAN);
  });
  it("final-two: a cut-at-the-final-three plan names nobody once three remain; before that it keeps", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "final-two" });
    g.rel.edge(promiser, promisee).threat = 0;
    setPlan(g, r.entryId!, promiser, { kind: "cut-final-three" });
    g.live.active = ["a", "b", "c", "d", "e"];
    expect(g.ctx().promiseFinalTwoFor!(promiser, [promisee, third])).toBe(promisee);
    g.live.active = [promiser, promisee, third];
    expect(g.ctx().promiseFinalTwoFor!(promiser, [promisee, third])).toBeUndefined();
  });
  it("the sealed ballot: a flip at the vote breaks it, but no claim and no visible line names the voter", () => {
    const { g, promiser, promisee, third } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-evict-vote" });
    g.rel.edge(promiser, promisee).threat = 0;
    setPlan(g, r.entryId!, promiser, { kind: "flip", moment: { week: g.live.week, at: "vote" } });
    expect(g.assuranceVoteFor(promisee, promiser)).toBe(0);
    g.assuranceVotedOut(promiser, promisee, [promiser, third]);
    expect(lied(g, promisee)).toEqual([]);
    expect(entry(g, r.entryId!).status).toBe("open");
  });
});

describe("the flags, the wall and persistence", () => {
  it("plans off: no plan is made and the promise is read as before", () => {
    const { g, promiser, promisee } = started({ plans: false });
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    expect(Object.keys(g.live.dealPlans ?? {}).filter(isLedgerPlanKey)).toEqual([]);
    expect(g.dealPlanSource().planOf(ledgerPlanKey(r.entryId!), promiser)).toBeUndefined();
  });
  it("promise terms off: nothing is recorded, so nothing is planned", () => {
    const { g, promiser, promisee } = started();
    g.setPromiseTermsEnabled(false);
    expect(g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" })).toEqual({ accepted: false, reason: "off" });
    expect(Object.keys(g.live.dealPlans ?? {}).filter(isLedgerPlanKey)).toEqual([]);
  });
  it("round-trips through a save: the plan survives, and a later write-once is still refused (monotone)", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-evict-vote" });
    setPlan(g, r.entryId!, promiser, { kind: "flip", moment: { week: g.live.week, at: "vote" } });
    const key = ledgerPlanKey(r.entryId!);
    const next = new GameSessionAdapter();
    next.restore(JSON.parse(JSON.stringify(g.snapshot())) as SessionSnapshot);
    const n = next as unknown as G;
    expect(n.dealPlanSource().planOf(key, promiser)).toEqual({ kind: "flip", moment: { week: g.live.week, at: "vote" }, madeWeek: g.live.week });
    expect(recordPlan(n.live.dealPlans!, key, promiser, { kind: "keep" }, 9)).toBe(false);
    expect(Object.keys(n.live.dealPlans!).length).toBeGreaterThanOrEqual(Object.keys(g.live.dealPlans!).length);
  });
  it("wall sentinel: the key and the plan reach no player-visible view", async () => {
    const { sb, g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    setPlan(g, r.entryId!, promiser, { kind: "break-at", moment: { week: g.live.week, at: "nominations" } });
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}), g.openLedgerHere(),
    ].map((x) => JSON.stringify(x)).join("\n");
    expect(surfaces).not.toMatch(/ledger:|break-at|cut-final-three|"flip"|dealPlans|madeWeek/);
  });
  it("the retrospective rows read the plan beside how the engine settled the promise", () => {
    const { g, promiser, promisee } = started();
    const r = g.recordPromiseTerm({ by: promiser, to: promisee, what: "no-nominate" });
    setPlan(g, r.entryId!, promiser, { kind: "break-at", moment: { week: g.live.week, at: "nominations" } });
    expect(ledgerPlanRetroRows(g.live.dealPlans, g.openLedger.entries)).toMatchObject([{ holder: promiser, with: promisee, plan: "break-at", outcome: "pending" }]);
    g.assuranceNominated(promiser, promisee);
    expect(ledgerPlanRetroRows(g.live.dealPlans, g.openLedger.entries)[0]!.outcome).toBe("carried-out");
  });
});
