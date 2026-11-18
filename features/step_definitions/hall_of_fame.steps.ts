import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";

/** Feature 0208 B3 - drives the played-season seam and the per-user hall. Roles only; prefix "hall of fame:". */
type Seam = { live: { finished?: boolean; winner?: string; beliefs?: Record<string, unknown> }; setSeasonMemoryEnabled(on: boolean): void };
type Bag = { reg: GameSessionRegistry; user: string; sentinel?: string };
const bag = (w: unknown): Bag => ((w as { hall0208?: Bag }).hall0208 ??= { reg: new GameSessionRegistry(), user: "hall-user" });
const start = (b: Bag, seed: number, on = true): Seam => {
  const sb = b.reg.sandboxFor(b.user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Seam;
  s.setSeasonMemoryEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  return s;
};
const finish = (s: Seam) => { s.live.finished = true; s.live.winner = "npc:other"; };
const hall = (b: Bag, user = b.user) => b.reg.sandboxFor(user).session.hallOfFame();

Given("hall of fame: a played season the player finished", function () { finish(start(bag(this), 5)); });
Given("hall of fame: a played season the player finished with a sealed fact in the hidden layer", function () {
  const b = bag(this); b.sentinel = "SENTINEL-HIDDEN-FACT";
  const s = start(b, 5); s.live.beliefs = { [b.sentinel]: { content: b.sentinel } }; finish(s);
});
Given("hall of fame: a played season the player finished with the memory switched off", function () { finish(start(bag(this), 5, false)); });
Given("hall of fame: two played seasons the player finished in turn", function () {
  const b = bag(this); finish(start(b, 5)); b.reg.resetUser(b.user); finish(start(b, 6)); b.reg.resetUser(b.user);
});
When("hall of fame: the next season begins", function () { const b = bag(this); b.reg.resetUser(b.user); });
Then("hall of fame: the hall holds that one season, numbered first", function () {
  const h = hall(bag(this)); assert.equal(h.seasonsPlayed, 1); assert.equal(h.seasons[0]!.season, 1);
});
Then("hall of fame: the hall holds both, in order", function () { assert.deepEqual(hall(bag(this)).seasons.map((r) => r.season), [1, 2]); });
Then("hall of fame: another player's hall is empty", function () { assert.equal(hall(bag(this), "hall-other").seasonsPlayed, 0); });
Then("hall of fame: the sealed fact is nowhere in the hall", function () { const b = bag(this); assert.ok(!JSON.stringify(hall(b)).includes(b.sentinel!)); });
Then("hall of fame: the hall is empty", function () { assert.equal(hall(bag(this)).seasonsPlayed, 0); });
