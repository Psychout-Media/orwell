import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0190 - the audience outside. Drives the REAL adapter (its after-eviction step and the post-crown retrospective) through a registry sandbox.
 * TEST-ONLY seams: the live season (the week's public record, finished), the event record, the player-event sink. Roles only.
 */
type Seam = {
  live: { playedGame?: boolean; week: number; finished?: boolean; weekDigests?: unknown[]; audience?: { live: { view: Record<string, number> }; full: { view: Record<string, number> } } };
  record?: { events(): unknown[] }; audienceAfterEviction(): void; onPlayerEvent?: (c: string, w: string[], k: string) => void;
  seasonRetrospective(): { americasFavorite?: { name: string } } | null;
};
type Bag = { sb?: UserSandbox; g?: Seam; events: string[]; villain?: string };
const bag = (w: unknown): Bag => ((w as { aud0190?: Bag }).aud0190 ??= { events: [] });
let n = 0;

Given("a played season with the audience on", function () {
  const b = bag(this);
  b.sb = new GameSessionRegistry().sandboxFor(`aud0190-${n++}`);
  b.sb.session.setAudienceEnabled(true);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 95 });
  b.g = b.sb.session as unknown as Seam;
  b.g.live.playedGame = true;
  const prior = b.g.onPlayerEvent; b.g.onPlayerEvent = (c, w, k) => { b.events.push(c); prior?.(c, w, k); };
});
const npcs = (b: Bag) => b.sb!.session.livingIds().filter((id) => id !== PLAYER);
Given("a week where the HOH nominated two houseguests and one was evicted", function () {
  const b = bag(this); const [hoh, a, c] = npcs(b);
  b.g!.live.weekDigests = [{ week: b.g!.live.week, hoh, nominees: [a, c], vetoHolder: hoh, vetoUsed: false, evictee: a, juryCount: 0 }];
});
Given("a houseguest whose betrayals all happened where the player could not see", function () {
  const b = bag(this); const [v, x] = npcs(b); b.villain = v;
  const hidden = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, type: "betrayal", initiator: v, witnessSet: [v, x], hidden: true }));
  b.g!.record = { events: () => hidden };
});
Given("a week the player won HOH and used the veto", function () {
  const b = bag(this); const [a, c] = npcs(b);
  b.g!.live.weekDigests = [{ week: b.g!.live.week, hoh: PLAYER, nominees: [a, c], vetoHolder: PLAYER, vetoUsed: true, evictee: a, juryCount: 0 }];
});
When("the eviction is over", function () { bag(this).g!.audienceAfterEviction(); });
Then("the evictee walks out to a reaction from the crowd, in words and never a number", function () {
  const b = bag(this); const line = b.events.find((c) => /walks out to/.test(c));
  assert.ok(line, "no walk-out reaction");
  assert.doesNotMatch(line!, /\d/);
});
Then("the crowd's view of them has not moved, but the recap's has", function () {
  const b = bag(this); const a = b.g!.live.audience!;
  assert.equal(a.live.view[b.villain!] ?? 0, 0, "the crowd reacted to what it could not see");
  assert.ok((a.full.view[b.villain!] ?? 0) < 0, "the recap did not count the hidden betrayals");
});
Then("the public thinks better of the player", function () {
  assert.ok((bag(this).g!.live.audience!.live.view[PLAYER] ?? 0) > 0);
});
Then("no favorite is named while the season is live", function () {
  assert.equal(bag(this).g!.seasonRetrospective(), null);
});
Then("after the crown the retrospective names America's Favorite", function () {
  const b = bag(this); b.g!.live.finished = true;
  assert.ok(b.g!.seasonRetrospective()?.americasFavorite?.name);
});
