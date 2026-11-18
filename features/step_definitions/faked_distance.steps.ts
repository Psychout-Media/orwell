import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { pairKey } from "../../src/engine/groupIdentity";

/** Feature 0184 part 2b - faked distance. Drives the REAL adapter. TEST-ONLY seams: the week's hiding set, the event record, the perceived-bond read, the player-event sink. Roles only. */
type Seam = {
  live: { playedGame?: boolean; week: number; pending?: unknown; hiding?: { week: number; pairs: string[] } };
  record?: { events(): unknown[] };
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void };
  setFakedDistanceEnabled(on: boolean): void; perceivedBond(h: string, a: string, b: string): number;
  playerCatchesHiddenPair(type: string, people: string[], place: string, presence: Map<string, string>, salt: string): void;
  onPlayerEvent?: (c: string, w: string[], k?: string) => string | undefined;
};
type Bag = { g?: Seam; ids: string[]; before?: { o: number; c: number }; caught: Array<{ c: string; w: string[] }> };
const bag = (w: unknown): Bag => ((w as { fd0184?: Bag }).fd0184 ??= { ids: [], caught: [] });
let n = 0;
const flat = { next: () => 0.5 };
Given("a played season with faked distance on", function () {
  const b = bag(this);
  const sb = new GameSessionRegistry().sandboxFor(`fd0184-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 72 });
  sb.session.advanceGame(); sb.session.advanceGame();
  b.g = sb.session as unknown as Seam; b.g.setFakedDistanceEnabled(true);
  b.g.live.playedGame = true; b.g.live.pending = undefined;
  b.ids = sb.session.livingIds().filter((i) => i !== PLAYER);
});
Given("two close allies who are hiding it this week", function () {
  const b = bag(this); const [a, x, , c] = b.ids as [string, string, string, string]; const g = b.g!;
  for (let i = 0; i < 8; i++) { g.rel.applyImpactDirected(a, x, { trust: 0.4, affinity: 0.4 }, flat); g.rel.applyImpactDirected(x, a, { trust: 0.4, affinity: 0.4 }, flat); }
  g.record = { events: () => [{ id: "s1", ts: 1, type: "bonding", initiator: a, witnessSet: [a, x], hidden: true, content: "", houseLife: { seenBy: [c] } }] };
  b.before = { o: g.perceivedBond(b.ids[2]!, a, x), c: g.perceivedBond(c, a, x) };
  g.live.hiding = { week: g.live.week, pairs: [pairKey(a, x)] };
});
Then("a houseguest who never caught them reads them as less close than before they hid it", function () {
  const b = bag(this); assert.ok(b.g!.perceivedBond(b.ids[2]!, b.ids[0]!, b.ids[1]!) < b.before!.o);
});
Then("a houseguest who caught them together still reads them as close", function () {
  const b = bag(this); assert.ok(Math.abs(b.g!.perceivedBond(b.ids[3]!, b.ids[0]!, b.ids[1]!) - b.before!.c) < 1e-9);
});
When("the pair keeps slipping off in a room the player is in", function () {
  const b = bag(this); const [a, x] = b.ids as [string, string];
  b.g!.onPlayerEvent = (c, w) => { b.caught.push({ c, w: [...w] }); return undefined; };
  const presence = new Map([[PLAYER, "backyard"], [a, "backyard"], [x, "backyard"]]);
  for (let i = 0; i < 60; i++) b.g!.playerCatchesHiddenPair("bonding", [a, x], "backyard", presence, `bdd:${i}`);
});
Then("the player sometimes catches them, as a scene only the player saw", function () {
  const b = bag(this);
  assert.ok(b.caught.length > 0 && b.caught.length < 60);
  assert.ok(b.caught.every((e) => e.w.length === 1 && e.w[0] === PLAYER));
});
Then("a houseguest close to the player who hides it makes the house read the player as less tied to them", function () {
  const b = bag(this); const g = b.g!; const ally = b.ids[4]!, onlooker = b.ids[5]!;
  for (let i = 0; i < 8; i++) { g.rel.applyImpactDirected(ally, PLAYER, { trust: 0.4, affinity: 0.4 }, flat); g.rel.applyImpactDirected(PLAYER, ally, { trust: 0.4, affinity: 0.4 }, flat); }
  const open = g.perceivedBond(onlooker, PLAYER, ally);
  g.live.hiding = { week: g.live.week, pairs: [...g.live.hiding!.pairs, pairKey(PLAYER, ally)] };
  assert.ok(g.perceivedBond(onlooker, PLAYER, ally) < open);
});
