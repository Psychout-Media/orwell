import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { DealRefusal, DealView } from "../../src/ports/GameSession";

// ORW-82 - the live consent scenario for 0039. HARD rule: roles only (houseguest, player). The engine (ORWELL_NPC_DEAL_CONSENT, default ON), not the narrator, decides whether the houseguest agrees.
interface Edge { trust: number; affinity: number; threat: number }
type Sess = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
interface ConsentState { s: Sess; npc: string; result: DealView | DealRefusal | null }
const state = new WeakMap<object, ConsentState>();
const st = (w: BbWorld): ConsentState => state.get(w)!;
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;

Given("a houseguest who distrusts the player", function (this: BbWorld) {
  const s = new GameSessionRegistry().sandboxFor(`dcl-${Math.random()}`).session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  s.advanceGame(); s.advanceGame();
  const npc = s.livingIds().find((id) => id !== PLAYER)!;
  const rel = (s as unknown as { rel: { edge(a: string, b: string): Edge } }).rel;
  Object.assign(rel.edge(npc, PLAYER), { trust: 0, affinity: 0.05, threat: 0.3 });
  state.set(this, { s, npc, result: null });
});

When("the player proposes a safety deal to them", function (this: BbWorld) {
  const c = st(this);
  c.result = c.s.makeDeal({ with: c.npc, kind: "safety", terms: "we look out for each other" });
});

Then("the houseguest refuses the deal", function (this: BbWorld) {
  const r = st(this).result;
  assert.ok(isRefusal(r), "the engine's consent check refuses a distrustful houseguest");
  assert.equal((r as DealRefusal).reason, "distrust");
});

Then("no deal is recorded", function (this: BbWorld) {
  assert.equal((st(this).s.getGameState().deals ?? []).length, 0);
});

Then("the refusal carries no numbers", function (this: BbWorld) {
  const r = st(this).result as DealRefusal;
  assert.doesNotMatch(JSON.stringify(r), /\d\.\d/);
  assert.deepEqual(Object.keys(r).sort(), ["narratable", "reason", "refused"]);
});
