import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { advanceClock } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { beatFeltHours } from "../../src/engine/daySchedule";
import { CLOCK } from "../../src/engine/sleepConstants";
import { resolvePending } from "../support/answerPending";

// Feature 0119 (Phase 3, final, in-game-time pivot) — different events cost different amounts of the
// in-game day. Roles only; in-game time only.

let pfdCeremony = 0;
let pfdComp = 0;

function playOutcome(clockOn: boolean, perConvOn: boolean, seed = 7): { winner?: string; order: string[] } {
  GameSessionAdapter.setTimeOfDayEnabled(clockOn);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`pfd${clockOn}${perConvOn}${seed}`);
  sb.session.createCharacter({ playerName: "Player", seed });
  sb.session.setPerConversationClockEnabled(perConvOn);
  for (let i = 0; i < 4000; i++) {
    const a = sb.session.advanceGame();
    if (a.pending) resolvePending(a.pending, (req) => sb.session.submitDecision(req));
    if (a.finished) break;
  }
  const snap = sb.session.snapshot();
  GameSessionAdapter.setTimeOfDayEnabled(null); // restore the default so the forced flag never leaks into later scenarios
  return { winner: snap.live?.winner, order: [...(snap.live?.evictionOrder ?? [])] };
}

When("the felt durations of the ceremony and competition beats are read", function (this: BbWorld) {
  pfdCeremony = beatFeltHours("nominations")!;
  pfdComp = beatFeltHours("hoh-competition")!;
});

Then("a ceremony advances the in-game clock by fewer hours than a competition", function () {
  assert.ok(pfdCeremony > 0 && pfdComp > 0, "both have a real duration");
  assert.ok(pfdCeremony < pfdComp, "a ceremony is quicker than a competition");
});

Then("an inert presentation beat has no distinct felt duration", function () {
  assert.equal(beatFeltHours("comp-elimination"), null);
  assert.equal(beatFeltHours("day-break"), null);
});

Given("a seeded season played with the per-beat clock at its flat default", function (this: BbWorld) {
  this.pfdFlat = playOutcome(true, false, 7); // the in-game clock ON: the per-beat clock block actually runs in both arms
});

Given("the same seeded season played with the variable felt durations available", function (this: BbWorld) {
  this.pfdVariable = playOutcome(true, true, 7);
});

When("both seasons are played to a winner", function (this: BbWorld) {
  assert.ok(this.pfdFlat && this.pfdVariable, "both seasons played");
});

Then("the winner and the whole eviction order are identical", function (this: BbWorld) {
  assert.ok(this.pfdFlat!.winner !== undefined, "the flat arm crowned a winner (a defined winner, not undefined===undefined)");
  assert.ok(this.pfdVariable!.winner !== undefined, "the variable arm crowned a winner");
  assert.equal(this.pfdVariable!.winner, this.pfdFlat!.winner, "same winner — the seeded stream is untouched");
  assert.deepEqual(this.pfdVariable!.order, this.pfdFlat!.order, "same eviction order");
});

let pfdBefore = 0;
let pfdAfter = 0;

When("a beat advances the clock with no felt duration supplied", function () {
  const s = { nightDepth: 10, timeOfDay: "morning" } as unknown as LiveSeasonState;
  pfdBefore = s.nightDepth as number;
  advanceClock(s); // the clock-off / pre-0119 path
  pfdAfter = s.nightDepth as number;
});

Then("it advances by the flat per-beat default", function () {
  assert.equal(pfdAfter - pfdBefore, CLOCK.perBeatHours, "the flat default holds when no felt duration is passed");
});
