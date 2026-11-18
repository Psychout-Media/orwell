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
  onlookers(room: string[], type: string, people: string[], salt: string): string[];
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
When("they spend time together in a room with others, again and again", function () {
  const b = bag(this); const [a, x, o, c] = b.ids as [string, string, string, string];
  const regs = Array.from({ length: 60 }, (_, i) => b.g!.onlookers([o, c], "bonding", [a, x], `bdd-room:${i}`));
  (b as unknown as { regs: string[][] }).regs = regs;
  const scenes = regs.map((seenBy, i) => ({ id: `r${i}`, ts: i, type: "bonding", initiator: a, witnessSet: [a, x], hidden: true, content: "", houseLife: { seenBy } }));
  b.g!.record = { events: () => scenes };
});
Then("only a few of the onlookers register it each time", function () {
  const regs = (bag(this) as unknown as { regs: string[][] }).regs;
  const share = regs.reduce((t, r) => t + r.length, 0) / (regs.length * 2);
  assert.ok(share > 0 && share < 0.4, `onlookers registered ${share}`);
});
Then("a houseguest who never caught them reads them as less close than one who did", function () {
  const b = bag(this); const [a, x, o, c] = b.ids as [string, string, string, string];
  const regs = (b as unknown as { regs: string[][] }).regs;
  const caught = (id: string) => regs.filter((r) => r.includes(id)).length;
  const [more, less] = caught(o) >= caught(c) ? [o, c] : [c, o];
  assert.ok(b.g!.perceivedBond(more, a, x) >= b.g!.perceivedBond(less, a, x));
  // an onlooker who caught nothing at all reads them as strangers
  const none = b.ids[5]!; assert.ok(b.g!.perceivedBond(none, a, x) <= b.g!.perceivedBond(more, a, x));
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
