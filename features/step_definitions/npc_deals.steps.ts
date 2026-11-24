import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import type { PlanSource } from "../../src/engine/npcDeals";
import { playDealsGame, type DealsGame } from "../../tests/support/npcDealsDriver";

// Feature 0170 - NPC deals and the HOH deal. Roles only. The plan store is injected (a stand-in here); the pact ledger is the real one.
type Deal = { id: string; status: string; kind: string; parties: EntityId[]; madeWeek?: number };
type G = {
  setNpcDealsEnabled(on: boolean): void; setPlanSource(s: PlanSource | undefined): void;
  setOnPlayerEvent(f: (c: string, w: string[], t?: string) => string | undefined): void; onPlayerEvent: (c: string, w: string[], t?: string) => string | undefined;
  dealNomPushFor(t: string, h: string): number; mintManyNpcDeals(): void; planAndCarryOutDeals(): void; livingIds(): string[];
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): Deal; serialize(): Deal[]; npcOnly(): Deal[] };
  rel: { edge(a: string, b: string): { trust: number; affinity: number } };
  live?: { week: number; beat?: string; playedGame?: boolean; dealPlans?: Record<string, Record<string, { kind: string; moment?: { week: number; at: string }; madeWeek: number; outcome?: string }>> }; snapshot(): unknown; restore(c: unknown): void; advanceGame(): unknown;
};
interface Ctx {
  g?: G; hoh?: EntityId; partner?: EntityId; trusted?: EntityId; distrusted?: EntityId; nominees?: EntityId[]; seeds: Array<{ g: G; hoh: EntityId; trusted: EntityId; distrusted: EntityId }>;
  events: Array<{ w: string[]; t?: string }>; made: Deal[];
  game?: DealsGame; copy?: G; first?: Deal[]; snap1?: { deals: Array<{ id: string }> }; runs: string[];
}
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = { seeds: [], events: [], made: [], runs: [] }; state.set(w, c); } return c; };

// The sandbox key is NOT only an isolation id: the orchestrator seeds the off-screen tick stream from `${seed}:${user}`, so a random key reshuffles the played season (ORW-826). Keys here are fixed.
function seat(seed: number): { g: G; a: EntityId; b: EntityId; c: EntityId } {
  const s = new GameSessionRegistry().sandboxFor(`npc-deals-${seed}`).session as unknown as G & { createCharacter(a: unknown): void };
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  s.advanceGame(); s.advanceGame();
  const [a, b, c] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  return { g: s, a, b, c };
}
const warm = (g: G): void => { for (const x of g.livingIds()) for (const y of g.livingIds()) if (x !== y) { const e = g.rel.edge(x, y); e.trust = 0.95; e.affinity = 0.95; } };
const ids6 = (g: G): EntityId[] => g.livingIds().filter((i) => i !== PLAYER).slice(0, 6);

/** A played-game pact between the HOH and one NPC, sealed through mintManyNpcDeals' ledger path (only that pair is trusting) and planned by main's planner. */
function playedPact(): { g: G; hoh: EntityId; partner: EntityId; id: string } {
  for (let seed = 1; seed < 80; seed++) {
    const t = seat(seed);
    for (const x of t.g.livingIds()) for (const y of t.g.livingIds()) if (x !== y) { const e = t.g.rel.edge(x, y); const pair = (x === t.a && y === t.b) || (x === t.b && y === t.a); e.trust = pair ? 0.95 : 0.1; e.affinity = pair ? 0.95 : 0.1; }
    t.g.setNpcDealsEnabled(true); t.g.mintManyNpcDeals();
    const d = t.g.deals.serialize().find((x) => x.parties.includes(t.a) && x.parties.includes(t.b) && x.madeWeek === t.g.live!.week);
    if (!d) continue;
    t.g.live!.playedGame = true; t.g.live!.beat = "hoh-competition";
    t.g.planAndCarryOutDeals();
    return { g: t.g, hoh: t.a, partner: t.b, id: d.id };
  }
  assert.fail("no seed sealed the pact");
}
Given("npc deals: a nervous houseguest and the HOH seal a pact in a played game", function (this: BbWorld) {
  const c = st(this) as Ctx & { dealId?: string }; const p = playedPact(); c.g = p.g; c.hoh = p.hoh; c.partner = p.partner; c.dealId = p.id;
});
Given("npc deals: the deal-plan planner has the HOH's plan be to break it at the nominations", function (this: BbWorld) {
  const c = st(this) as Ctx & { dealId?: string }; const live = c.g!.live!; const store = live.dealPlans![c.dealId!]!;
  store[c.hoh!] = { kind: "break-at", moment: { week: live.week, at: "nominations" }, madeWeek: live.week };
  store[c.partner!] = { kind: "keep", madeWeek: live.week };
});
When("npc deals: the carry-out runs at the nominations and the HOH names the nominees", function (this: BbWorld) {
  const c = st(this); c.g!.live!.beat = "nominations"; c.g!.planAndCarryOutDeals();
  c.nominees = nominationPlan(c.hoh!, ids6(c.g!), new RelationshipModel(0.5), { dealPush: (t) => c.g!.dealNomPushFor(t, c.hoh!) }).nominees as EntityId[];
});
Then("npc deals: the pact is broken and the former partner is among the nominees", function (this: BbWorld) {
  const c = st(this) as Ctx & { dealId?: string };
  assert.equal(c.g!.deals.serialize().find((d) => d.id === c.dealId)!.status, "broken");
  assert.ok(c.nominees!.includes(c.partner!));
});
Then("npc deals: the lean toward the former partner ends with that week", function (this: BbWorld) {
  const c = st(this); assert.ok(c.g!.dealNomPushFor(c.partner!, c.hoh!) > 0);
  c.g!.live!.week += 1; assert.ok(!(c.g!.dealNomPushFor(c.partner!, c.hoh!) > 0));
});

Given("npc deals: an NPC HOH holds a safety deal with two houseguests, one they trust and one they do not", function (this: BbWorld) {
  const c = st(this);
  for (let seed = 1; seed <= 12; seed++) {
    const t = seat(seed); t.g.setNpcDealsEnabled(true);
    t.g.deals.make([t.a, t.b], "safety", "t", undefined, t.g.live!.week); t.g.deals.make([t.a, t.c], "safety", "t", undefined, t.g.live!.week);
    { const e = t.g.rel.edge(t.a, t.b); e.trust = 0.95; e.affinity = 0.95; }
    { const e = t.g.rel.edge(t.a, t.c); e.trust = 0.05; e.affinity = 0.05; }
    c.seeds.push({ g: t.g, hoh: t.a, trusted: t.b, distrusted: t.c });
  }
});
When("npc deals: the NPC HOH names the nominees across many seeds", function (this: BbWorld) {
  const c = st(this) as Ctx & { named?: { trusted: number; distrusted: number } }; c.named = { trusted: 0, distrusted: 0 };
  for (const s of c.seeds) {
    const field = [s.hoh, s.trusted, s.distrusted, ...ids6(s.g).filter((i) => ![s.hoh, s.trusted, s.distrusted].includes(i)).slice(0, 1)];
    const noms = nominationPlan(s.hoh, field, new RelationshipModel(0.5), { dealPush: (t) => s.g.dealNomPushFor(t, s.hoh) }).nominees;
    if (noms.includes(s.trusted)) c.named!.trusted++; if (noms.includes(s.distrusted)) c.named!.distrusted++;
  }
});
Then("npc deals: the distrusted houseguest is named more often than the trusted one", function (this: BbWorld) {
  const c = st(this) as Ctx & { named?: { trusted: number; distrusted: number } };
  assert.ok(c.named!.distrusted > c.named!.trusted, JSON.stringify(c.named));
});

Given("npc deals: two NPCs strike a deal off-screen in a played game", function (this: BbWorld) {
  const c = st(this);
  for (let seed = 1; seed < 60; seed++) {
    const t = seat(seed); warm(t.g);
    const events: Array<{ w: string[]; t?: string }> = [];
    const prev = t.g.onPlayerEvent; t.g.setOnPlayerEvent((x, w, ty) => { events.push({ w, t: ty }); return prev(x, w, ty); });
    t.g.setNpcDealsEnabled(true);
    const before = t.g.deals.serialize().length; t.g.mintManyNpcDeals();
    const made = t.g.deals.serialize().slice(before);
    if (made.length) { t.g.live!.playedGame = true; t.g.live!.beat = "hoh-competition"; c.g = t.g; c.events = events; c.made = made; return; }
  }
  assert.fail("no seed struck a deal");
});
When("npc deals: the deal-plan planner runs", function (this: BbWorld) { st(this).g!.planAndCarryOutDeals(); });
Then("npc deals: each side of the pact holds a plan in the plan store", function (this: BbWorld) {
  const c = st(this);
  for (const d of c.made) assert.deepEqual(Object.keys(c.g!.live!.dealPlans?.[d.id] ?? {}).sort(), [...d.parties].sort());
});
Then("npc deals: the deal's event names only those two as witnesses", function (this: BbWorld) {
  const c = st(this); assert.ok(c.events.length > 0);
  for (const e of c.events) { assert.equal(e.w.length, 2); assert.ok(!e.w.includes(PLAYER)); }
});

Given("npc deals: a played season where NPCs struck deals and one plans to break it", async function (this: BbWorld) {
  const c = st(this); c.game = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: "bdd-npcdeals-view" });
  assert.ok(c.game.session.deals.npcOnly().length > 0);
  (c.game.session as unknown as G).setPlanSource({ planOf: () => ({ kind: "break-at", moment: { week: 1, at: "nominations" } }) });
});
When("npc deals: the days pass until the vote", async function (this: BbWorld) { await st(this).game!.more(120, (x) => x.week() >= 4); });
Then("npc deals: no player or admin view shows the deal, either plan, or any trust figure", async function (this: BbWorld) {
  const c = st(this); const player = c.game!.reg.resolver()("player", c.game!.user), admin = c.game!.reg.resolver()("admin", c.game!.user);
  const blob = JSON.stringify([
    await player.callTool("getGameState", {}), await player.callTool("gameStatus", {}), await player.callTool("getMomentPrompt", {}),
    await player.callTool("seasonRecap", {}), await admin.callTool("inspectNonVaultState", {}),
  ]);
  for (const needle of ["settle a quiet", "quiet pact sealed", "planOf", "\"flip\"", "cut-final-three", "break-at", "this-week"]) assert.ok(!blob.includes(needle), needle);
});

Given("npc deals: two seasons prepared from the same seed", function (this: BbWorld) {
  const c = st(this); c.seeds = [];
  for (let i = 0; i < 2; i++) { const t = seat(5); warm(t.g); t.g.setNpcDealsEnabled(true); c.seeds.push({ g: t.g, hoh: t.a, trusted: t.b, distrusted: t.c }); }
});
When("npc deals: each house proposes its week's deals", function (this: BbWorld) {
  const c = st(this); c.runs = [];
  for (const s of c.seeds) { s.g.mintManyNpcDeals(); s.g.live!.playedGame = true; s.g.live!.beat = "hoh-competition"; s.g.planAndCarryOutDeals(); c.runs.push(JSON.stringify([s.g.deals.serialize(), s.g.live!.dealPlans ?? {}])); }
});
Then("npc deals: both hold the same deals and plans in the same order", function (this: BbWorld) { const c = st(this); assert.equal(c.runs[0], c.runs[1]); assert.ok(JSON.parse(c.runs[0]!)[0].length > 0); assert.ok(Object.keys(JSON.parse(c.runs[0]!)[1]).length > 0); });

Given("npc deals: a played season where NPCs struck deals", async function (this: BbWorld) {
  const c = st(this); c.game = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: "bdd-npcdeals-save" });
  c.first = c.game.session.deals.serialize() as unknown as Deal[]; assert.ok(c.first.length > 0);
});
When("npc deals: the season is saved and loaded into a fresh session", function (this: BbWorld) {
  const c = st(this); c.snap1 = JSON.parse(JSON.stringify(c.game!.session.snapshot()));
  c.copy = new GameSessionRegistry().sandboxFor("bdd-npcdeals-copy").session as unknown as G; c.copy.restore(c.snap1);
});
Then("npc deals: the loaded session holds every deal the saved one held", function (this: BbWorld) { const c = st(this); assert.equal(JSON.stringify(c.copy!.deals.serialize()), JSON.stringify(c.first)); });
Then("npc deals: a later save never holds fewer deals", async function (this: BbWorld) {
  const c = st(this); await c.game!.more(700, (x) => x.week() >= 5);
  const later = JSON.parse(JSON.stringify(c.game!.session.snapshot())) as { deals: Array<{ id: string }> }; const ids = new Set(later.deals.map((d) => d.id));
  for (const d of c.snap1!.deals) assert.ok(ids.has(d.id)); assert.ok(later.deals.length >= c.snap1!.deals.length);
});

Given("npc deals: a pact whose HOH holder plans to keep it", function (this: BbWorld) {
  const c = st(this) as Ctx & { dealId?: string }; const p = playedPact(); c.g = p.g; c.hoh = p.hoh; c.partner = p.partner; c.dealId = p.id;
  const live = c.g.live!; live.dealPlans![p.id]![p.hoh] = { kind: "keep", madeWeek: live.week }; live.dealPlans![p.id]![p.partner] = { kind: "keep", madeWeek: live.week };
});
Then("npc deals: the HOH's lean toward the partner stays protective after the carry-out", function (this: BbWorld) {
  const c = st(this); c.g!.live!.beat = "nominations"; c.g!.planAndCarryOutDeals(); assert.ok(c.g!.dealNomPushFor(c.partner!, c.hoh!) < 0);
});
Then("npc deals: in a headless game the planner runs nothing and the lean is protective", function (this: BbWorld) {
  const t = seat(9); t.g.setNpcDealsEnabled(true); t.g.deals.make([t.a, t.b], "safety", "t", undefined, t.g.live!.week);
  t.g.planAndCarryOutDeals(); assert.equal(t.g.live!.dealPlans, undefined); assert.ok(t.g.dealNomPushFor(t.b, t.a) < 0);
});
