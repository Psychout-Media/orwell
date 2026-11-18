import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { YourEditView } from "../../src/engine/yourEdit";

/**
 * Feature 0200 - your edit. Drives the REAL adapter's post-crown retrospective through a registry sandbox.
 * TEST-ONLY seams: the live season (weeks, the finish flag), the event record and the deal book. Roles only.
 */
type Digest = { week: number; hoh: string; nominees: string[]; vetoHolder: string; vetoUsed: boolean; evictee: string; juryCount: number };
type Seam = {
  live: { playedGame?: boolean; finished?: boolean; week: number; weekDigests?: Digest[]; statedReasons?: unknown[]; voteRecord?: unknown[]; winner?: string };
  record?: { events(): unknown[]; hidden?(): unknown[] }; nameOf(id: string): string; deals: { all: unknown[] };
  seasonRetrospective(): { yourEdit?: YourEditView } | null;
};
type Bag = { sb?: UserSandbox; g?: Seam; edit?: YourEditView; villain?: string };
const bag = (w: unknown): Bag => ((w as { ye0200?: Bag }).ye0200 ??= {});
let n = 0;
const npcs = (b: Bag) => b.sb!.session.livingIds().filter((id) => id !== PLAYER);

Given("a played season whose crown has not been given", function () {
  const b = bag(this);
  b.sb = new GameSessionRegistry().sandboxFor(`ye0200-${n++}`);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 200 });
  b.g = b.sb.session as unknown as Seam;
  b.g.live.playedGame = true;
});
Then("the retrospective is sealed and there is no edit", function () {
  assert.equal(bag(this).g!.seasonRetrospective(), null);
});
Given("a played season whose crown has been given after two weeks of events", function () {
  const b = bag(this);
  b.sb = new GameSessionRegistry().sandboxFor(`ye0200-${n++}`);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 201 });
  b.g = b.sb.session as unknown as Seam;
  const [a, c, d, e] = npcs(b);
  b.g.live.playedGame = true;
  b.g.live.weekDigests = [
    { week: 1, hoh: a!, nominees: [c!, d!], vetoHolder: a!, vetoUsed: false, evictee: c!, juryCount: 0 },
    { week: 2, hoh: d!, nominees: [e!, a!], vetoHolder: d!, vetoUsed: false, evictee: e!, juryCount: 0 },
  ];
  // week 1 was a blindside: the HOH had publicly called the evictee a pawn
  b.g.live.statedReasons = [{ week: 1, day: 1, decider: a, public: true, decision: "nominate", real: { choice: c, terms: [] }, stated: { kind: "pawn-youll-be-fine", about: c, candor: "lie" } }];
  b.g.live.voteRecord = [{ week: 1, evictee: c, voteOf: { [d!]: c, [e!]: c, [a!]: c } }, { week: 2, evictee: e, voteOf: { [a!]: e, [c!]: e, [d!]: a } }];
  b.g.live.finished = true;
  b.g.live.winner = a;
});
Given("a houseguest who betrayed another again and again", function () {
  const b = bag(this); const [v, x] = npcs(b); b.villain = v;
  b.g!.record = { hidden: () => [], events: () => Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, type: "betrayal", initiator: v, witnessSet: [v, x], hidden: true, content: `s${i}` })) };
});
Given("a player who broke their deals and blindsided the house", function () {
  const b = bag(this); const [a, c] = npcs(b);
  b.g!.live.weekDigests = [1, 2, 3].map((week) => ({ week, hoh: PLAYER, nominees: [a!, c!], vetoHolder: PLAYER, vetoUsed: false, evictee: a!, juryCount: 0 }));
  b.g!.live.statedReasons = [1, 2, 3].map((week) => ({ week, day: 1, decider: PLAYER, public: true, decision: "nominate", real: { choice: a, terms: [] }, stated: { kind: "pawn-youll-be-fine", about: a, candor: "lie" } }));
  b.g!.live.voteRecord = [];
  const mk = (other: string) => ({ id: `d${other}`, parties: [PLAYER, other], kind: "safety", terms: "x", condition: { promisors: [PLAYER] }, status: "broken", brokenBy: PLAYER });
  b.g!.deals.all.push(mk(a!), mk(c!));
});
When("the season is opened", function () {
  const b = bag(this); b.edit = b.g!.seasonRetrospective()?.yourEdit;
  assert.ok(b.edit, "no edit after the crown");
});
Then("there is one episode for each completed week, each built from that week's own moments", function () {
  const e = bag(this).edit!;
  const weeks = e.episodes.filter((x) => !x.crown);
  assert.deepEqual(weeks.map((x) => x.week), [1, 2]);
  for (const ep of weeks) assert.ok(ep.moments.length > 0 && ep.title.length > 0);
});
Then("the week with a blindside leads with the blindside", function () {
  assert.equal(bag(this).edit!.episodes[0]!.moments[0]!.kind, "blindside");
});
Then("that houseguest was cut as a villain", function () {
  const b = bag(this);
  assert.ok(b.edit!.villains.map((v) => v.name).includes(b.g!.nameOf(b.villain!)), "the betrayer was not cut as a villain");
});
Then("the player did not come across as a hero", function () {
  assert.notEqual(bag(this).edit!.you.band, "hero");
});
Then("the edit says what the player did, in words and never a number", function () {
  const y = bag(this).edit!.you;
  assert.ok(y.dealsBroken >= 2 && y.blindsidesDealt >= 3);
  assert.doesNotMatch(y.line, /\d/);
});
