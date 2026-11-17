import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import type { DealPlan, PlanSource } from "../../src/engine/npcDeals";
import { playDealsGame, type DealsGame } from "../../tests/support/npcDealsDriver";

// Feature 0170 - NPC deals and the HOH deal. Roles only. The plan store is injected (a stand-in here); the pact ledger is the real one.
type Deal = { id: string; status: string; kind: string; parties: EntityId[]; madeWeek?: number };
type G = {
  setNpcDealsEnabled(on: boolean): void; setPlanSource(s: PlanSource | undefined): void; setRecordPlan(f: ((d: string, h: string, p: DealPlan) => void) | undefined): void;
  setOnPlayerEvent(f: (c: string, w: string[], t?: string) => string | undefined): void; onPlayerEvent: (c: string, w: string[], t?: string) => string | undefined;
  dealNomPushFor(t: string, h: string): number; mintManyNpcDeals(): void; livingIds(): string[];
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): Deal; serialize(): Deal[]; npcOnly(): Deal[] };
  rel: { edge(a: string, b: string): { trust: number; affinity: number } };
  live?: { week: number }; snapshot(): unknown; restore(c: unknown): void; advanceGame(): unknown;
};
interface Ctx {
  g?: G; hoh?: EntityId; partner?: EntityId; trusted?: EntityId; distrusted?: EntityId; nominees?: EntityId[]; seeds: Array<{ g: G; hoh: EntityId; trusted: EntityId; distrusted: EntityId }>;
  plans: Array<[string, string, DealPlan]>; events: Array<{ w: string[]; t?: string }>; made: Deal[];
  game?: DealsGame; copy?: G; first?: Deal[]; snap1?: { deals: Array<{ id: string }> }; runs: string[];
}
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = { seeds: [], plans: [], events: [], made: [], runs: [] }; state.set(w, c); } return c; };

function seat(seed: number): { g: G; a: EntityId; b: EntityId; c: EntityId } {
  const s = new GameSessionRegistry().sandboxFor(`npc-deals-${seed}-${Math.random()}`).session as unknown as G & { createCharacter(a: unknown): void };
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  s.advanceGame(); s.advanceGame();
  const [a, b, c] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  return { g: s, a, b, c };
}
const warm = (g: G): void => { for (const x of g.livingIds()) for (const y of g.livingIds()) if (x !== y) { const e = g.rel.edge(x, y); e.trust = 0.95; e.affinity = 0.95; } };
const ids6 = (g: G): EntityId[] => g.livingIds().filter((i) => i !== PLAYER).slice(0, 6);

Given("npc deals: a nervous houseguest trades the HOH their vote for safety", function (this: BbWorld) {
  const c = st(this); const t = seat(7); c.g = t.g; c.hoh = t.a; c.partner = t.b; // `hoh` = the nervous one, who wins next; `partner` = the former HOH
  const d = t.g.deals.make([t.b, t.a], "safety", "a quiet pact sealed away from the cameras", undefined, t.g.live!.week);
  d.status = "kept"; // the pact ran its course with the week
  (c as Ctx & { dealId?: string }).dealId = d.id;
});
Given("npc deals: that houseguest's own plan is to turn on the HOH once safe", function (this: BbWorld) {
  const c = st(this) as Ctx & { dealId?: string }; const week = c.g!.live!.week;
  c.g!.setPlanSource({ planOf: (id, h) => (id === c.dealId && h === c.hoh ? { kind: "break-at", moment: { week, at: "nominations" } } : undefined) });
  c.g!.setNpcDealsEnabled(true);
});
When("npc deals: that houseguest wins the next HOH and names the nominees", function (this: BbWorld) {
  const c = st(this); c.g!.live!.week += 1;
  c.nominees = nominationPlan(c.hoh!, ids6(c.g!), new RelationshipModel(0.5), { dealPush: (t) => c.g!.dealNomPushFor(t, c.hoh!) }).nominees as EntityId[];
});
Then("npc deals: the former HOH is among the nominees", function (this: BbWorld) { const c = st(this); assert.ok(c.nominees!.includes(c.partner!)); });

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

Given("npc deals: two NPCs strike a deal off-screen", function (this: BbWorld) {
  const c = st(this);
  for (let seed = 1; seed < 60; seed++) {
    const t = seat(seed); warm(t.g);
    const plans: Array<[string, string, DealPlan]> = []; const events: Array<{ w: string[]; t?: string }> = [];
    t.g.setRecordPlan((d, h, p) => plans.push([d, h, p]));
    const prev = t.g.onPlayerEvent; t.g.setOnPlayerEvent((x, w, ty) => { events.push({ w, t: ty }); return prev(x, w, ty); });
    t.g.setNpcDealsEnabled(true);
    const before = t.g.deals.serialize().length; t.g.mintManyNpcDeals();
    const made = t.g.deals.serialize().slice(before);
    if (made.length && plans.some((p) => p[0] === made[0]!.id)) { c.g = t.g; c.plans = plans; c.events = events; c.made = made; return; }
  }
  assert.fail("no seed struck a deal");
});
Then("npc deals: each side's plan was handed to the plan store, and the two plans can differ", function (this: BbWorld) {
  const c = st(this);
  for (const d of c.made) assert.deepEqual(c.plans.filter((p) => p[0] === d.id).map((p) => p[1]).sort(), [...d.parties].sort());
  let differ = false;
  for (let seed = 1; seed < 120 && !differ; seed++) {
    const t = seat(seed % 12 + 1); warm(t.g); const got: Array<[string, string, DealPlan]> = [];
    // a different house each try: vary the HOH's pair loyalty by seed through the trust of one side
    t.g.rel.edge(t.a, t.b).trust = 0.5 + (seed % 7) / 20; t.g.setRecordPlan((d, h, p) => got.push([d, h, p])); t.g.setNpcDealsEnabled(true); t.g.mintManyNpcDeals();
    const ids = [...new Set(got.map((x) => x[0]))];
    for (const id of ids) { const two = got.filter((x) => x[0] === id); if (two.length === 2 && JSON.stringify(two[0]![2]) !== JSON.stringify(two[1]![2])) differ = true; }
  }
  assert.ok(differ, "the two sides never held different plans");
});
Then("npc deals: the deal's event names only those two as witnesses", function (this: BbWorld) {
  const c = st(this); assert.ok(c.events.length > 0);
  for (const e of c.events) { assert.equal(e.w.length, 2); assert.ok(!e.w.includes(PLAYER)); }
});

Given("npc deals: a played season where NPCs struck deals and one plans to break it", async function (this: BbWorld) {
  const c = st(this); c.game = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: `bdd-npcdeals-${Math.random()}` });
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
  for (const s of c.seeds) { const plans: unknown[] = []; s.g.setRecordPlan((d, h, p) => plans.push([d, h, p])); s.g.mintManyNpcDeals(); c.runs.push(JSON.stringify([s.g.deals.serialize(), plans])); }
});
Then("npc deals: both hold the same deals and plans in the same order", function (this: BbWorld) { const c = st(this); assert.equal(c.runs[0], c.runs[1]); assert.ok(JSON.parse(c.runs[0]!)[0].length > 0); });

Given("npc deals: a played season where NPCs struck deals", async function (this: BbWorld) {
  const c = st(this); c.game = await playDealsGame(3, 900, { until: (x) => x.week() >= 3, user: `bdd-npcdeals-save-${Math.random()}` });
  c.first = c.game.session.deals.serialize() as unknown as Deal[]; assert.ok(c.first.length > 0);
});
When("npc deals: the season is saved and loaded into a fresh session", function (this: BbWorld) {
  const c = st(this); c.snap1 = JSON.parse(JSON.stringify(c.game!.session.snapshot()));
  c.copy = new GameSessionRegistry().sandboxFor(`bdd-npcdeals-copy-${Math.random()}`).session as unknown as G; c.copy.restore(c.snap1);
});
Then("npc deals: the loaded session holds every deal the saved one held", function (this: BbWorld) { const c = st(this); assert.equal(JSON.stringify(c.copy!.deals.serialize()), JSON.stringify(c.first)); });
Then("npc deals: a later save never holds fewer deals", async function (this: BbWorld) {
  const c = st(this); await c.game!.more(700, (x) => x.week() >= 5);
  const later = JSON.parse(JSON.stringify(c.game!.session.snapshot())) as { deals: Array<{ id: string }> }; const ids = new Set(later.deals.map((d) => d.id));
  for (const d of c.snap1!.deals) assert.ok(ids.has(d.id)); assert.ok(later.deals.length >= c.snap1!.deals.length);
});
