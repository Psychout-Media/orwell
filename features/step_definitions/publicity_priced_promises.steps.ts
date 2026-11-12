import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger } from "../../src/engine/deals";
import type { ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { DEAL_DURATION } from "../../src/engine/relationshipConstants";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

// Feature 0140 - publicity-priced promises. Roles only. Formation witnesses come from the live session path; the fold and breach
// rules run on the real DealLedger + RelationshipModel with a recording sink (the unit gate's own seam).
type Internals = {
  presence: Map<EntityId, string> | null;
  setDealsWitnessesEnabled(on: boolean): void;
  deals: { forParty(id: EntityId): Array<{ formationWitnesses?: EntityId[] }> };
};
const PROMISOR = npc(1);
const PROTECT = npc(2);
const WIT = Array.from({ length: 200 }, (_, i) => npc(10 + i));

interface Ctx {
  live?: { s: GameSessionAdapter; g: Internals; partner: EntityId; present: EntityId[]; absent: EntityId };
  flags: { dealsWitnesses?: boolean; dealDepth?: boolean };
  audience: number;
  gains: { small: number; big: number; huge: number; none: number; bigDepth: number; noneDepth: number };
  reveals: { wronged: EntityId[]; witnesses: EntityId[] };
  witnesses: EntityId[];
}
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = { flags: {}, audience: 0, gains: { small: 0, big: 0, huge: 0, none: 0, bigDepth: 0, noneDepth: 0 }, reveals: { wronged: [], witnesses: [] }, witnesses: [] }; state.set(w, c); } return c; };

function gain(witnessCount: number, flags: { dealsWitnesses?: boolean; dealDepth?: boolean }): number {
  const rel = new RelationshipModel(0.5);
  const sink: ReconcileSink = { rel, rng: new SeededRandom(7), juryDemerit: () => {}, reveal: () => "evt:1", ...flags } as ReconcileSink;
  const ledger = new DealLedger();
  const d = ledger.make([PROMISOR, PROTECT], "comp-throw", "throw it", undefined, 1, undefined, WIT.slice(0, witnessCount));
  const before = rel.edge(PROTECT, PROMISOR).trust;
  ledger.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "threw" }, sink);
  assert.equal(d.status, "kept");
  return rel.edge(PROTECT, PROMISOR).trust - before;
}

// --- Scenario: witnesses present at formation are recorded ---
Given("a deal made with other houseguests present", function (this: BbWorld) {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  const sb = new GameSessionRegistry().sandboxFor(`pub-${Math.random()}`);
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed: 7 });
  for (let i = 0; i < 3; i++) s.advanceGame();
  const g = s as unknown as Internals;
  g.setDealsWitnessesEnabled(true);
  const [partner, w1, w2, w3] = s.livingIds().filter((id) => id !== PLAYER) as EntityId[];
  const edge = (s as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number } } }).rel.edge(partner!, PLAYER);
  edge.trust = 0.9; edge.affinity = 0.9; // the partner agrees to the deal
  g.presence = new Map<EntityId, string>([[PLAYER, "kitchen"], [partner!, "kitchen"], [w1!, "kitchen"], [w2!, "kitchen"], [w3!, "backyard"]]);
  st(this).live = { s, g, partner: partner!, present: [w1!, w2!], absent: w3! };
});
When("the deal is committed", function (this: BbWorld) {
  const l = st(this).live!;
  const made = l.s.makeDeal({ with: l.partner, kind: "safety", terms: "we keep each other safe this week" });
  assert.ok(made && !("refused" in (made as object)), "the deal was made");
  const deals = l.g.deals.forParty(PLAYER);
  st(this).witnesses = deals[deals.length - 1]!.formationWitnesses ?? [];
});
Then("those co-present houseguests, excluding both parties, are its formation witnesses", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.deepEqual([...c.witnesses].sort(), [...l.present].sort());
  assert.ok(!c.witnesses.includes(PLAYER) && !c.witnesses.includes(l.partner));
  assert.ok(!c.witnesses.includes(l.absent), "someone in another room did not witness it");
});

// --- Scenario: a bigger audience raises the fold only up to the cap ---
Given("a deal made before a large audience and the deal-witnesses flag on", function (this: BbWorld) { st(this).flags = { dealsWitnesses: true }; });
When("the deal is later kept and the honored fold is applied", function (this: BbWorld) {
  const c = st(this);
  const need = Math.ceil((DEAL_DURATION.maxScale - 1) / DEAL_DURATION.perWitness);
  c.audience = need;
  c.gains.none = gain(0, c.flags); c.gains.small = gain(3, c.flags); c.gains.big = gain(need, c.flags); c.gains.huge = gain(need + 50, c.flags);
  c.gains.noneDepth = gain(0, { ...c.flags, dealDepth: true }); c.gains.bigDepth = gain(8, { ...c.flags, dealDepth: true });
});
Then("the fold is scaled by audience size and never above the cap", function (this: BbWorld) {
  const g = st(this).gains;
  assert.ok(g.none > 0);
  assert.ok(g.small > g.none, "a bigger audience raises the fold");
  assert.ok(g.big > g.small);
  assert.ok(Math.abs(g.huge - g.big) < 1e-9, "past the cap nothing more is added");
  assert.ok(g.big <= g.none * DEAL_DURATION.maxScale + 1e-9, "never above the cap");
});
Then("with the deal-depth layer also on, the loyalty-streak multiplier replaces the audience scale", function (this: BbWorld) {
  const g = st(this).gains;
  assert.ok(Math.abs(g.bigDepth - g.noneDepth) < 1e-9, "audience size no longer scales the fold");
});

// --- Scenario: a breach reaches exactly the witnesses ---
Given("the deal-witnesses flag is on and a witnessed deal that is later broken", function (this: BbWorld) {
  st(this).flags = { dealsWitnesses: true };
  st(this).witnesses = WIT.slice(0, 4);
});
When("the breach is recorded", function (this: BbWorld) {
  const c = st(this);
  const sink: ReconcileSink = {
    rel: new RelationshipModel(0.5), rng: new SeededRandom(7), juryDemerit: () => {}, ...c.flags,
    reveal: (wronged) => { c.reveals.wronged.push(wronged); return "evt:1"; },
    revealToWitness: (witness) => { c.reveals.witnesses.push(witness); },
  } as ReconcileSink;
  const ledger = new DealLedger();
  const d = ledger.make([PROMISOR, PROTECT], "comp-throw", "throw it", undefined, 1, undefined, c.witnesses);
  ledger.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "won" }, sink);
  assert.equal(d.status, "broken");
});
Then("the wronged party learns of it through the existing reveal", function (this: BbWorld) { assert.deepEqual(st(this).reveals.wronged, [PROTECT]); });
Then("each formation witness additionally receives a collateral copy", function (this: BbWorld) {
  const c = st(this);
  assert.deepEqual([...c.reveals.witnesses].sort(), [...c.witnesses].sort());
});
Then("the collateral copy goes to no one outside the formation witnesses", function (this: BbWorld) {
  const c = st(this);
  for (const w of c.reveals.witnesses) assert.ok(c.witnesses.includes(w));
  assert.ok(!c.reveals.witnesses.includes(PROMISOR) && !c.reveals.witnesses.includes(PROTECT));
});
