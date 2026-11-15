import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../support/answerPending";

/**
 * Ryne's 2026-11-15 rulings, as BDD (they had unit tests only): zero clocks (ORW-377), the "early morning" label (ORW-392), the awake list
 * (ORW-383) - feature 0066 - and headcounts that include the player (ORW-376) - feature 0078. Drives the real adapter. Roles only.
 */

type Bag = {
  s?: GameSessionAdapter;
  prompts?: string[];
  phasesSeen?: Set<string>;
  st3am?: Record<string, unknown>;
  st1am?: Record<string, unknown>;
  night?: { awake: string[]; asleep: string[]; arrived: string[] };
};
const bag = (w: unknown): Bag => ((w as { rulings?: Bag }).rulings ??= {});
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;
const live = (s: GameSessionAdapter) => (s as unknown as { live: Record<string, unknown> }).live; // a TEST-ONLY seam, as in tests/unit/zeroClocks.test.ts
let n = 0;

After(() => GameSessionAdapter.setTimeOfDayEnabled(null));

Given("a started season whose in-game clock is running", function () {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`rulings-${n++}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  s.setPerConversationClockEnabled(true);
  for (let i = 0; i < 80 && live(s).timeOfDay === undefined; i++) s.advanceGame(); // the first beat starts the day
  assert.ok(live(s).timeOfDay, "the in-game clock never started");
  bag(this).s = s;
});

When("the day moves on through many messages with zero clocks on", function () {
  const b = bag(this); const s = b.s!;
  b.prompts = []; b.phasesSeen = new Set();
  for (let i = 0; i < 60; i++) {
    b.prompts.push(s.getMomentPrompt({ zeroClocks: true }).systemPrompt);
    b.phasesSeen.add(String(live(s).timeOfDay));
    s.advanceClockPerConversation(); s.advanceClockPerConversation();
  }
});

Then("every narrator prompt names a part of the day and states no clock time", function () {
  for (const p of bag(this).prompts!) {
    const lines = p.split("\n");
    assert.ok(lines.some((l) => l.startsWith("- Part of the day: ")), "a prompt names no part of the day");
    assert.ok(!p.includes("- Clock: "), "a prompt still carries the clock line");
    // the only clock-looking text allowed is the rule's own quoted counter-examples on the part-of-day line: strip just the
    // "quoted" spans there and scan everything else, the band line included (review of #2739)
    const scanned = lines.map((l) => (l.startsWith("- Part of the day: ") ? l.replace(/"[^"]*"/g, "") : l)).join("\n");
    assert.doesNotMatch(scanned, CLOCK_TIME, "a prompt states a clock time");
  }
});

Then("the engine's own clock moved through more than one part of the day", function () {
  assert.ok(bag(this).phasesSeen!.size > 1, `the engine clock never left ${[...bag(this).phasesSeen!].join(",")}`);
});

When("the player is still up at 3am", function () {
  const b = bag(this); const s = b.s!; const l = live(s);
  const at = (hour: number) => { l.timeOfDay = "late-night"; l.nightDepth = hour; return s.gameStatus() as unknown as Record<string, unknown>; };
  b.st3am = at(27);
  b.st1am = at(25);
});

Then("the status says early morning", function () {
  assert.equal(bag(this).st3am!.earlyMorning, true, "3am did not read as early morning");
});

Then("at 1am the status does not say early morning", function () {
  assert.notEqual(bag(this).st1am!.earlyMorning, true, "1am read as early morning (it is still late night)");
});

When("the night has thinned the house", function () {
  const b = bag(this); const s = b.s!;
  type St = { asleep?: Array<{ name: string }>; awake?: Array<{ name: string }> };
  let st = s.gameStatus() as unknown as St;
  for (let i = 0; i < 400 && !(st.asleep && st.asleep.length > 0); i++) { s.advanceClockPerConversation(); st = s.gameStatus() as unknown as St; }
  assert.ok(st.asleep && st.asleep.length > 0, "nobody ever turned in - the night never thinned the house");
  const arrived = s.getGameState().house.filter((h) => h.status === "active").map((h) => h.name);
  b.night = { awake: (st.awake ?? []).map((x) => x.name), asleep: st.asleep.map((x) => x.name), arrived };
});

Then("the status lists the houseguests who are awake", function () {
  assert.ok(bag(this).night!.awake.length > 0, "the status lists nobody as awake");
});

Then("no houseguest is listed as both awake and asleep", function () {
  const { awake, asleep } = bag(this).night!;
  assert.deepEqual(awake.filter((x) => asleep.includes(x)), []);
});

Then("every houseguest in the house is listed as one or the other", function () {
  const { awake, asleep, arrived } = bag(this).night!;
  assert.deepEqual([...awake, ...asleep].sort(), [...arrived].sort());
});

// --- 0078: headcounts include the player (ORW-376) ---------------------------------------------------------------------------------
function seasonAt(pred: (s: GameSessionAdapter) => boolean): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`rulings-hc-${n++}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "The Player", seed });
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (pred(s)) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("no seed reached the wanted point");
}

Given("a season that has reached its nominations", function () {
  bag(this).s = seasonAt((s) => s.getGameState().phase === "nominations");
});

Given("a season that has reached an eviction vote", function () {
  bag(this).s = seasonAt((s) => s.getGameState().pending?.kind === "eviction-vote");
});

Then("the player's room count is the houseguests with them plus the player", function () {
  const wa = bag(this).s!.whereabouts()!;
  assert.ok(wa.counts, "the engine states no headcounts");
  assert.equal(wa.counts.others, wa.present.length, "others is not the houseguests with the player");
  assert.equal(wa.counts.room, wa.present.length + 1, "the room count leaves the player out");
});

Then("the house count is everyone still in the game, the player included", function () {
  const s = bag(this).s!;
  assert.equal(s.whereabouts()!.counts!.house, s.livingIds().length);
});

Then("the voter count is the house minus the HOH and the two nominees", function () {
  const s = bag(this).s!; const c = s.whereabouts()!.counts!;
  assert.ok(c.voters !== undefined, "no voter count on eviction night");
  assert.equal(c.voters, c.house - 3, `voters ${c.voters} with ${c.house} in the house`);
});
