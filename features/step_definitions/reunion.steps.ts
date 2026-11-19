import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { ReunionView, YourStoriesView } from "../../src/engine/reunionRetro";

/**
 * Feature 0211 - the reunion and the story of you and them (ORW-649, ORW-648). Drives the REAL adapter's post-crown retrospective through a registry sandbox.
 * TEST-ONLY seams: the live season (the crown flag, the grudge book, the claim log, the weekly samples). Roles only.
 */
type Row = { kind: string; week: number; day: number; severity: number; peak: number; eased: number; refKey: string };
type Seam = {
  live: { playedGame?: boolean; finished?: boolean; winner?: string; grudges?: Record<string, Row>; claims?: { seq: number; items: unknown[] }; viewOfPlayer?: Record<string, Array<{ week: number; trust: number; affinity: number }>> };
  alliances: { add(n: string, f: string, m: string[], b: number): unknown };
  seasonRetrospective(): { reunion?: ReunionView; yourStories?: YourStoriesView } | null;
};
type Bag = { sb?: UserSandbox; g?: Seam; ids?: string[]; reunion?: ReunionView; stories?: YourStoriesView };
const bag = (w: unknown): Bag => ((w as { ru0211?: Bag }).ru0211 ??= {});
let n = 0;
function stage(b: Bag): void {
  b.sb = new GameSessionRegistry().sandboxFor(`ru0211-${n++}`);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 211 });
  b.g = b.sb.session as unknown as Seam;
  b.ids = b.sb.session.livingIds().filter((id) => id !== PLAYER);
  b.g.live.playedGame = true;
}
const row = (week: number): Row => ({ kind: "blindsided", week, day: 1, severity: 0.8, peak: 0.8, eased: 0, refKey: "k" });
const lie = (id: number, speaker: string, listener: string, week: number) => ({ id: `claim:${id}`, speaker, listener, kind: "targets-you", subject: speaker, week, isTrue: false, intent: "mislead", origin: "engine" });

function crowned(b: Bag): void {
  stage(b);
  const [a, c, d, e] = b.ids!;
  b.g!.live.grudges = { [`${a}|${PLAYER}`]: row(2), [`${c}|${d}`]: row(3) };
  b.g!.live.claims = { seq: 2, items: [lie(1, PLAYER, e!, 2), lie(2, c!, a!, 3)] };
  b.g!.alliances.add("Hidden Pair", d!, [d!, e!], 1);
  assert.equal(b.g!.seasonRetrospective(), null, "nothing before the crown");
  b.g!.live.finished = true; b.g!.live.winner = a;
  const r = b.g!.seasonRetrospective()!;
  b.reunion = r.reunion; b.stories = r.yourStories;
}
Given("a winner has been crowned", function () { crowned(bag(this)); });
Then("the evicted houseguests return for a reunion scene with the finalists", function () {
  assert.ok(bag(this).reunion && bag(this).reunion!.threads.length > 0, "no reunion after the crown");
});
Then("rivals with the biggest grudges confront each other, the player included either way", function () {
  const t = bag(this).reunion!.threads.filter((x) => x.kind === "confrontation");
  assert.ok(t.length >= 2);
  assert.ok(t.some((x) => x.kind === "confrontation" && x.youAreIn), "the player is in a confrontation");
});
Then("lies never caught in the game come out in front of the people they were told to", function () {
  const t = bag(this).reunion!.threads.filter((x) => x.kind === "lie");
  assert.equal(t.length, 2);
  assert.ok(t.some((x) => x.kind === "lie" && x.youAre === "speaker"), "the player's own lie comes out too");
});
Then("alliances hidden from someone are explained", function () {
  assert.ok(bag(this).reunion!.threads.some((x) => x.kind === "alliance" && x.hiddenFrom.length > 0));
});
Then("none of it is said before the crown", function () {
  const b = bag(this); b.g!.live.finished = false;
  assert.equal(b.g!.seasonRetrospective(), null);
  b.g!.live.finished = true;
});

Given("the player is part of a confrontation or a lie coming out", function () { crowned(bag(this)); });
Then("the player answers in their own words, and the engine never speaks for the player", function () {
  const json = JSON.stringify(bag(this).reunion);
  assert.ok(bag(this).reunion!.threads.some((x) => (x.kind === "confrontation" && x.youAreIn) || (x.kind === "lie" && x.youAre)), "a thread holds the player");
  assert.ok(!/"(answer|answers|playerSays|playerSaid)"/.test(json), "the engine carries no words for the player");
});

Given("a finished season whose houseguests held a view of the player", function () {
  const b = bag(this); stage(b);
  const [a, c] = b.ids!;
  b.g!.live.viewOfPlayer = {
    // ORW-691: the samples are raw edge values (an unmet pair reads 0.25 + 0.25), the shape is read against that neutral baseline
    [a!]: [{ week: 1, trust: 0.3, affinity: 0.3 }, { week: 2, trust: 0.3, affinity: 0.3 }, { week: 3, trust: 0.7, affinity: 0.7 }],
    [c!]: [{ week: 1, trust: 0.5, affinity: 0.5 }, { week: 2, trust: 0.5, affinity: 0.5 }],
  };
  b.g!.live.finished = true; b.g!.live.winner = c;
  b.stories = b.g!.seasonRetrospective()!.yourStories;
});
Then("for each houseguest there is a story of them and the player: how they met, the turning points, and how it ended", function () {
  const b = bag(this);
  assert.equal(b.stories!.stories.length, b.ids!.length);
  for (const s of b.stories!.stories) assert.ok(s.line.length > 0 && s.ended.how);
});
Then("its shape follows how their view of the player really moved, warmed, cooled, turned or steady", function () {
  const b = bag(this);
  const by = new Map(b.stories!.stories.map((s) => [s.name, s]));
  const nameOf = (id: string): string => (b.sb!.session as unknown as { nameOf(i: string): string }).nameOf(id);
  assert.equal(by.get(nameOf(b.ids![0]!))!.shape, "warmed");
  assert.equal(by.get(nameOf(b.ids![1]!))!.shape, "steady");
});
Then("no number is shown", function () {
  const json = JSON.stringify(bag(this).stories);
  assert.ok(!/\d\.\d|"trust"|"affinity"|npc:\d/.test(json));
});
