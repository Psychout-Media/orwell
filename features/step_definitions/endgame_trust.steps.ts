import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0193 - the endgame changes the rules of trust. Drives the REAL adapter (its "can I beat you?" read and the week's deal tests) through a registry sandbox.
 * TEST-ONLY seams: the live season (who is left, the jury, the comp record), the deal ledger, the relationship model, the player-event sink. Roles only.
 */
type Seam = {
  live: { playedGame?: boolean; week: number; active: string[]; evictionOrder: string[]; resume?: Record<string, number>; pending?: unknown; assurances?: { items: Array<{ from: string; to: string; kind: string }> } };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): unknown };
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void };
  endgameFor(t: string, d: string): number; endgameTests(): void; setEndgameTrustEnabled(on: boolean): void;
  onPlayerEvent?: (c: string, w: string[], k?: string) => string | undefined;
};
type Bag = { g?: Seam; npcs: string[]; jurors: string[]; heard: Array<{ c: string; w: string[] }>; before?: Map<string, number>; pair?: [string, string]; withPlayer?: string; count?: number };
const bag = (w: unknown): Bag => ((w as { eg0193?: Bag }).eg0193 ??= { npcs: [], jurors: [], heard: [] });
let n = 0;
const flat = { next: () => 0.5 };

function seat(world: unknown, left: number): void {
  const b = bag(world);
  const sb = new GameSessionRegistry().sandboxFor(`eg0193-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 93 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setEndgameTrustEnabled(true);
  g.live.playedGame = true; g.live.pending = undefined;
  const npcs = g.live.active.filter((i) => i !== PLAYER);
  const stay = npcs.slice(0, left - 1);
  const out = npcs.slice(left - 1);
  g.live.active = [PLAYER, ...stay];
  g.live.evictionOrder = [...g.live.evictionOrder, ...out];
  b.g = g; b.npcs = stay; b.jurors = out.slice(-5);
  const prior = g.onPlayerEvent; g.onPlayerEvent = (c, w, k) => { b.heard.push({ c, w: [...w] }); return prior?.(c, w, k); };
}
Given("a played season at the final four with the endgame on", function () { seat(this, 4); });
Given("a played season at the final five with the endgame on", function () { seat(this, 5); });
Given("the jury is close to one houseguest", function () {
  const b = bag(this); const fav = b.npcs[1]!;
  for (const j of b.jurors) for (let i = 0; i < 3; i++) b.g!.rel.applyImpactDirected(j, fav, { trust: 0.3, affinity: 0.3 }, flat);
});
Then("another houseguest reads that one as someone they can't beat, by their own read of the jury", function () {
  const b = bag(this); assert.ok(b.g!.endgameFor(b.npcs[1]!, b.npcs[0]!) > 0);
});
Then("that houseguest reads them as someone they can beat in turn", function () {
  const b = bag(this); assert.ok(b.g!.endgameFor(b.npcs[0]!, b.npcs[1]!) < 0);
});
When("the player wins more competitions", function () {
  const b = bag(this); b.before = new Map(b.npcs.map((h) => [h, b.g!.endgameFor(PLAYER, h)]));
  b.g!.live.resume = { ...(b.g!.live.resume ?? {}), [PLAYER]: (b.g!.live.resume?.[PLAYER] ?? 0) + 4 };
});
Then("the houseguests read the player as harder to beat than before", function () {
  const b = bag(this); for (const [h, v] of b.before!) assert.ok(b.g!.endgameFor(PLAYER, h) > v);
});
Given("two houseguests hold a final two", function () {
  const b = bag(this); b.pair = [b.npcs[0]!, b.npcs[1]!]; b.g!.deals.make(b.pair, "final-two", "t", undefined, b.g!.live.week);
});
Given("a houseguest holds a final two with the player", function () {
  const b = bag(this); b.withPlayer = b.npcs[2]!; b.g!.deals.make([b.withPlayer, PLAYER], "final-two", "t", undefined, b.g!.live.week);
});
When("the endgame week begins", function () { const b = bag(this); b.g!.endgameTests(); b.count = b.g!.live.assurances?.items.length ?? 0; });
Then("each of the two houseguests is reassured by the other, for the engine to keep or break", function () {
  const b = bag(this); const [x, y] = b.pair!; const items = b.g!.live.assurances?.items ?? [];
  assert.ok(items.some((a) => a.from === x && a.to === y)); assert.ok(items.some((a) => a.from === y && a.to === x));
});
Then("the player is asked to their face whether their final two still stands, in words and never a number", function () {
  const b = bag(this); const asked = b.heard.filter((h) => /final two still stands/.test(h.c));
  assert.equal(asked.length, 1); assert.deepEqual(asked[0]!.w, [b.withPlayer!, PLAYER]); assert.doesNotMatch(asked[0]!.c, /\d/);
});
Then("nothing is said for the player", function () {
  assert.ok(!(bag(this).g!.live.assurances?.items ?? []).some((a) => a.from === PLAYER));
});
Then("it happens once a week", function () {
  const b = bag(this); b.g!.endgameTests();
  assert.equal(b.g!.live.assurances?.items.length ?? 0, b.count); assert.equal(b.heard.filter((h) => /final two still stands/.test(h.c)).length, 1);
});
Then("no houseguest weighs whether they can beat anyone", function () {
  const b = bag(this); for (const h of b.npcs) assert.equal(b.g!.endgameFor(PLAYER, h), 0);
});
