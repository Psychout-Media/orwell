import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { FavorLedger } from "../../src/engine/favors";

/**
 * Feature 0195 - what the evicted take with them. Drives the REAL adapter's after-eviction settle through a registry sandbox.
 * TEST-ONLY seams: the live season (who is left, the secret plans), the deal and favor ledgers, the relationship model, a soul read. Roles only.
 */
type Deal = { id: string; status: string; kind: string; parties: string[] };
type Seam = {
  live: { playedGame?: boolean; week: number; active: string[]; evictionOrder: string[]; pending?: unknown; dealPlans?: Record<string, Record<string, { kind: string; madeWeek: number }>> };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): Deal; all: Deal[] };
  favors: FavorLedger;
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void };
  evictedTakeWithThem(): void; setEvictedTakeEnabled(on: boolean): void; soulObj(id: string): { emotionalState: number } | undefined;
};
type Bag = { g?: Seam; npcs: string[]; mood: Map<string, number>; deals: Record<string, string>; roles: Record<string, string>; snap?: string };
const bag = (w: unknown): Bag => ((w as { et0195?: Bag }).et0195 ??= { npcs: [], mood: new Map(), deals: {}, roles: {} });
let n = 0;
const flat = { next: () => 0.5 };
const mood = (b: Bag, id: string) => b.g!.soulObj(id)!.emotionalState;
const evict = (b: Bag, id: string) => { const g = b.g!; g.live.active = g.live.active.filter((x) => x !== id); g.live.evictionOrder = [...g.live.evictionOrder, id]; g.evictedTakeWithThem(); };

Given("a played season with the evicted taking what they held", function () {
  const b = bag(this);
  const sb = new GameSessionRegistry().sandboxFor(`et0195-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 95 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setEvictedTakeEnabled(true);
  g.live.playedGame = true; g.live.pending = undefined;
  b.g = g; b.npcs = g.live.active.filter((i) => i !== PLAYER);
});
Given("an NPC holds a final two with a partner who secretly planned to break it", function () {
  const b = bag(this); const [e, liar] = b.npcs as [string, string];
  b.roles.evictee = e; b.roles.liar = liar;
  const d = b.g!.deals.make([e, liar], "final-two", "t", undefined, b.g!.live.week);
  (b.g!.live.dealPlans ??= {})[d.id] = { [liar]: { kind: "cut-final-three", madeWeek: b.g!.live.week } };
  b.deals.f2 = d.id; b.mood.set(liar, mood(b, liar));
});
Given("the same NPC holds a safety deal with another partner", function () {
  const b = bag(this); const shielded = b.npcs[2]!; b.roles.shielded = shielded;
  b.deals.safety = b.g!.deals.make([b.roles.evictee!, shielded], "safety", "t", undefined, b.g!.live.week).id; b.mood.set(shielded, mood(b, shielded));
});
Given("the player owes an NPC a favor, and the NPC has a close ally in the house", function () {
  const b = bag(this); const [e, ally] = b.npcs as [string, string]; b.roles.evictee = e; b.roles.ally = ally;
  for (let i = 0; i < 6; i++) b.g!.rel.applyImpactDirected(e, ally, { trust: 0.4, affinity: 0.4 }, flat);
  b.g!.favors.owe({ owedBy: PLAYER, owedTo: e, origin: "t", beat: 1 });
});
Given("an NPC owes the player a favor", function () {
  const b = bag(this); const debtor = b.npcs[0]!; b.roles.debtor = debtor;
  b.g!.favors.owe({ owedBy: debtor, owedTo: PLAYER, origin: "t", beat: 1 }); b.mood.set(debtor, mood(b, debtor));
});
Given("the player holds a final two with an NPC", function () {
  const b = bag(this); b.deals.mine = b.g!.deals.make([PLAYER, b.npcs[1]!], "final-two", "t", undefined, b.g!.live.week).id;
});
When("the NPC is evicted", function () { const b = bag(this); evict(b, b.roles.evictee!); });
When("the player is evicted", function () { evict(bag(this), PLAYER); });
When("the house settles the eviction again", function () {
  const b = bag(this); b.snap = JSON.stringify([b.g!.deals.all, b.g!.favors.all, [...b.mood.keys()].map((id) => mood(b, id))]); b.g!.evictedTakeWithThem();
});
const status = (b: Bag, id: string) => b.g!.deals.all.find((d) => d.id === id)!.status;
Then("both deals lapse, neither kept nor broken", function () {
  const b = bag(this); assert.equal(status(b, b.deals.f2!), "lapsed"); assert.equal(status(b, b.deals.safety!), "lapsed");
});
Then("the partner who planned to break it is relieved", function () { const b = bag(this); assert.ok(mood(b, b.roles.liar!) > b.mood.get(b.roles.liar!)!); });
Then("the partner it shielded worries", function () { const b = bag(this); assert.ok(mood(b, b.roles.shielded!) < b.mood.get(b.roles.shielded!)!); });
Then("the ally now holds the favor the player owes, and can call it in", function () {
  const b = bag(this); const held = b.g!.favors.openHeldBy(b.roles.ally!);
  assert.equal(held.length, 1); assert.equal(held[0]!.owedBy, PLAYER);
});
Then("the favor owed to the player lapses and is not passed on", function () {
  const b = bag(this); const mine = b.g!.favors.all.filter((f) => f.owedTo === PLAYER);
  assert.ok(mine.length > 0 && mine.every((f) => f.state === "lapsed"));
});
Then("the player's final two lapses", function () { const b = bag(this); assert.equal(status(b, b.deals.mine!), "lapsed"); });
Then("the NPC who owed the player is relieved", function () { const b = bag(this); assert.ok(mood(b, b.roles.debtor!) > b.mood.get(b.roles.debtor!)!); });
Then("nothing more changes", function () {
  const b = bag(this); assert.equal(JSON.stringify([b.g!.deals.all, b.g!.favors.all, [...b.mood.keys()].map((id) => mood(b, id))]), b.snap);
});
