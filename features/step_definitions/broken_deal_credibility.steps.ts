import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Deal } from "../../src/engine/deals";

// Feature 0162 - a broken deal lowers the breaker's credibility (ORW-545). Roles only. Drives the REAL GameSessionAdapter.
type Internals = {
  presence: Map<EntityId, string> | null;
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setNpcMemoryEnabled(on: boolean): void;
  setDealsWitnessesEnabled(on: boolean): void;
  reconcileDeals(a: { actor: EntityId; kind: "nominate"; targets: EntityId[] }): void;
  writeDealBreakLie(holder: EntityId, breaker: EntityId, deal: Deal, role: "wronged" | "witness"): void;
  deals: { serialize(): Deal[] };
};
interface Table { s: GameSessionAdapter; g: Internals; wronged: EntityId; onlookers: EntityId[]; away: EntityId; bystander: EntityId }
interface Ctx { t?: Table; before: Map<EntityId, number>; after: Map<EntityId, number> }
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = { before: new Map(), after: new Map() }; state.set(w, c); } return c; };

function seatTable(liesCaught = true): Table {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  const s = new GameSessionRegistry().sandboxFor(`bdc-${liesCaught}`).session as unknown as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", seed: 7 });
  for (let i = 0; i < 3; i++) s.advanceGame();
  const g = s as unknown as Internals;
  g.setNpcMemoryEnabled(true);
  g.setDealsWitnessesEnabled(true);
  (s as unknown as { setLiesCaughtEnabled(on: boolean): void }).setLiesCaughtEnabled(liesCaught);
  const [wronged, w1, w2, away, bystander] = s.livingIds().filter((id) => id !== PLAYER);
  const seat = () => { g.presence = new Map<EntityId, string>([[PLAYER, "kitchen"], [wronged!, "kitchen"], [w1!, "kitchen"], [w2!, "kitchen"], [away!, "backyard"], [bystander!, "backyard"]]); };
  seat();
  for (const id of [wronged!, w1!, w2!]) for (const o of [PLAYER, wronged!, w1!, w2!]) if (id !== o) { const e = g.rel.edge(id, o); e.trust = 0.05; e.affinity = 0.05; }
  { const e = g.rel.edge(wronged!, PLAYER); e.trust = 0.9; e.affinity = 0.9; e.threat = 0; }
  s.noteMessage({ messageId: "m-0" });
  seat();
  s.makeDeal({ with: wronged!, kind: "safety", terms: "we keep each other safe" });
  return { s, g, wronged: wronged!, onlookers: [w1!, w2!], away: away!, bystander: bystander! };
}
const everyone = (t: Table): EntityId[] => [t.wronged, ...t.onlookers, t.away, t.bystander];
const snap = (t: Table, into: Map<EntityId, number>): void => { into.clear(); for (const id of everyone(t)) into.set(id, t.s.credibilityOf(id, PLAYER)); };
const breakIt = (t: Table): void => t.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [t.wronged] });
const T = (w: BbWorld): Table => st(w).t!;

Given("two houseguests who made a deal in front of two others", function (this: BbWorld) { const c = st(this); c.t = seatTable(); snap(c.t, c.before); });
When("one of them breaks the deal", function (this: BbWorld) { const c = st(this); breakIt(c.t!); snap(c.t!, c.after); });
When("the deal is kept to the letter", function (this: BbWorld) {
  const c = st(this);
  c.t!.g.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [c.t!.bystander] }); // the partner is spared
  snap(c.t!, c.after);
});
When("the same break is counted a second time", function (this: BbWorld) {
  const t = T(this), deal = t.g.deals.serialize()[0]!;
  t.g.writeDealBreakLie(t.wronged, PLAYER, deal, "wronged");
  for (const w of t.onlookers) t.g.writeDealBreakLie(w, PLAYER, deal, "witness");
  const again = new Map<EntityId, number>(); snap(t, again);
  assert.deepEqual([...again], [...st(this).after]);
});

Then("the wronged houseguest believes the breaker's word for less than before", function (this: BbWorld) {
  const c = st(this); assert.ok(c.after.get(c.t!.wronged)! < c.before.get(c.t!.wronged)!);
});
Then("each onlooker believes the breaker's word for less than before", function (this: BbWorld) {
  const c = st(this); for (const w of c.t!.onlookers) assert.ok(c.after.get(w)! < c.before.get(w)!, `onlooker ${w}`);
});
Then("each onlooker believes it for more than the wronged houseguest does", function (this: BbWorld) {
  const c = st(this); for (const w of c.t!.onlookers) assert.ok(c.after.get(w)! > c.after.get(c.t!.wronged)!, `onlooker ${w}`);
});
Then("nobody believes the keeper's word for less than before", function (this: BbWorld) {
  const c = st(this); for (const id of everyone(c.t!)) assert.equal(c.after.get(id), c.before.get(id), `houseguest ${id}`);
});
Then("a houseguest in another room still believes the breaker in full", function (this: BbWorld) {
  const c = st(this); assert.equal(c.after.get(c.t!.away), 1); assert.equal(c.after.get(c.t!.bystander), 1);
});
Then("the wronged houseguest still believes everyone else in full", function (this: BbWorld) {
  const t = T(this); for (const id of [...t.onlookers, t.away, t.bystander]) assert.equal(t.s.credibilityOf(t.wronged, id), 1, `speaker ${id}`);
});
Then("no houseguest believes the breaker's word more than before", function (this: BbWorld) {
  const c = st(this); for (const id of everyone(c.t!)) assert.ok(c.after.get(id)! <= c.before.get(id)!, `houseguest ${id}`);
});
Then("every houseguest's belief in the breaker is exactly what it was after the first count", function (this: BbWorld) {
  const t = T(this), again = new Map<EntityId, number>(); snap(t, again);
  assert.deepEqual([...again], [...st(this).after]);
});
Then("no player or admin view carries a credibility figure or a caught-lie marker", function (this: BbWorld) {
  const t = T(this); breakIt(t);
  const views = JSON.stringify([t.s.getGameState(), t.s.seasonRecap(), t.s.dailyRecap(), t.s.whereabouts()]);
  assert.ok(!/credib|lied-to-me|caught.?lie/i.test(views));
});
Then("the same break with the lies-caught layer off leaves every relationship exactly as it is with it on", function (this: BbWorld) {
  const edges = (t: Table): string => JSON.stringify([PLAYER, ...everyone(t)].flatMap((a) => [PLAYER, ...everyone(t)].filter((b) => b !== a).map((b) => t.g.rel.edge(a, b))));
  const on = seatTable(true); breakIt(on);
  const off = seatTable(false); breakIt(off);
  assert.equal(edges(on), edges(off));
});
