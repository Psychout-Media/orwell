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
  exitCrowd(id: string): string | undefined; rel: { edge(a: string, b: string): { threat: number } };
  seasonRetrospective(): { americasFavorite?: { name: string } } | null;
};
type Bag = { sb?: UserSandbox; g?: Seam; events: string[]; heard: Array<{ c: string; w: string[] }>; villain?: string; evictee?: string; threat?: Map<string, number> };
const bag = (w: unknown): Bag => ((w as { aud0190?: Bag }).aud0190 ??= { events: [], heard: [] });
let n = 0;

Given("a played season with the audience on", function () {
  const b = bag(this);
  b.sb = new GameSessionRegistry().sandboxFor(`aud0190-${n++}`);
  b.sb.session.setAudienceEnabled(true);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 95 });
  b.g = b.sb.session as unknown as Seam;
  b.g.live.playedGame = true;
  const prior = b.g.onPlayerEvent; b.g.onPlayerEvent = (c, w, k) => { b.events.push(c); b.heard.push({ c, w: [...w] }); prior?.(c, w, k); };
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

// Follow-up: the walk out at the exit interview, the player's own crowd, and the fan reward read as a threat.
const inProgress = (b: Bag, evictee: string): void => {
  const live = b.g!.live as Record<string, unknown> & { week: number };
  const [hoh, other] = npcs(b).filter((id) => id !== evictee);
  Object.assign(live, { hoh, nominees: [evictee, other], finalNominees: [evictee, other], vetoHolder: hoh, vetoUsed: false });
  b.evictee = evictee;
};
Given("an eviction in progress whose evictee is a houseguest", function () { const b = bag(this); inProgress(b, npcs(b)[0]!); });
Given("an eviction in progress whose evictee is the player", function () { inProgress(bag(this), PLAYER); });
When("the evictee's exit interview begins", function () { const b = bag(this); b.g!.exitCrowd(b.evictee!); });
Then("the crowd they walk out to is decided, in words and never a number", function () {
  const b = bag(this); const line = b.heard.find((h) => /walks out/.test(h.c));
  assert.ok(line, "no walk out"); assert.doesNotMatch(line!.c, /\d/);
});
Then("the house hears it, the evictee is not told the house's news", function () {
  const b = bag(this); const line = b.heard.find((h) => /walks out/.test(h.c))!;
  assert.ok(line.w.length > 0); assert.ok(!line.w.includes(b.evictee!));
});
Then("when the eviction is over the walk out is not repeated", function () {
  const b = bag(this); const live = b.g!.live as Record<string, unknown> & { week: number };
  live.weekDigests = [{ week: live.week, hoh: live.hoh, nominees: live.finalNominees, vetoHolder: live.vetoHolder, vetoUsed: false, evictee: b.evictee, juryCount: 0 }];
  b.g!.audienceAfterEviction();
  assert.equal(b.heard.filter((h) => /walks out/.test(h.c)).length, 1);
});
Then("the player alone hears the crowd they walk out to", function () {
  const own = bag(this).heard.filter((h) => /walks out of the house/.test(h.c));
  assert.equal(own.length, 1); assert.deepEqual(own[0]!.w, [PLAYER]);
});
Given("a fan-reward week the player won HOH and used the veto", function () {
  const b = bag(this); const [a, c] = npcs(b); const live = b.g!.live as Record<string, unknown> & { week: number; active: string[] };
  live.week = 4;
  b.g!.live.weekDigests = [{ week: 4, hoh: PLAYER, nominees: [a, c], vetoHolder: PLAYER, vetoUsed: true, evictee: a, juryCount: 0 }];
  live.active = live.active.filter((id) => id !== a);
  b.threat = new Map(npcs(b).map((h) => [h, b.g!.rel.edge(h, PLAYER).threat]));
});
Then("the player wins the viewers' vote", function () {
  assert.ok(bag(this).events.some((c) => /wins the viewers' vote/.test(c) && c.startsWith("The Player")));
});
Then("every houseguest reads the player as more of a threat than before", function () {
  const b = bag(this);
  for (const [h, t] of b.threat!) assert.ok(b.g!.rel.edge(h, PLAYER).threat > t, "a houseguest did not read the favorite as a threat");
});
