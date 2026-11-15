import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { CLOCK } from "../../src/engine/sleepConstants";
import { priv, setup, at } from "../../tests/support/napWorld";
import type { HangOutReq, HangOutView } from "../../src/ports/GameSession";
import type { SessionCore } from "../../src/engine/sessionSnapshot";

/**
 * FEATURE 0049 / ORW-445 (engine half) - a stated wait reaches the clock. The front end turns the player's own words ("a couple of hours",
 * "the rest of the morning") into a `hangOut` request with `maxMinutes` and/or `untilBandEnd`; these scenarios drive the REAL adapter's `hangOut`
 * on a played, turn-driven game (the shared nap world). Roles only.
 *
 * A hang-out can still be cut short by a side-stream roll (the player is pulled, an NPC approaches, something is observed) - those stops have their
 * own coverage. Here the step tries hang-out rolls (restoring the same parked moment each time) until one is NOT cut short before the length under
 * test, then asserts on that run. A run that overshoots is always accepted, so an implementation that runs too long is caught, never skipped.
 */
type Bag = { s?: GameSessionAdapter; core?: string; startHour?: number; t0?: number; r?: HangOutView; dueHour?: number };
const bag = (w: unknown): Bag => ((w as { statedWait?: Bag }).statedWait ??= {});
const hourOf = (s: GameSessionAdapter): number => priv(s).live.nightDepth;
const afternoon = CLOCK.phaseStartsHour.afternoon;
const close = (a: number, b: number, msg: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

After(function () { GameSessionAdapter.setTimeOfDayEnabled(null); });

/** Park a played game at `hour` and remember the moment, so every hang-out roll starts from the same state. */
function park(w: unknown, hour: number): Bag {
  const b = bag(w);
  const { s, reg } = setup(3);
  // a blind save per mutation (no integrity checkpoint): the steps restore the parked moment between rolls, which the checkpoint would read as lost detail
  reg.setCommit((u) => reg.saveUser(u));
  // a houseguest whose own desire clock has run out walks over on a fixed schedule (no roll to retry past); that stop has its own scenarios
  s.setDesireClockEnabled(false);
  at(s, hour);
  b.s = s; b.startHour = hour;
  b.core = JSON.stringify(s.snapshot());
  return b;
}
const minutesToNextEvent = (s: GameSessionAdapter): number => {
  const d = (s.getGameState() as { daySchedule?: { due: boolean; minutesUntil?: number } }).daySchedule;
  assert.ok(d && d.due === false && typeof d.minutesUntil === "number", "the parked moment has a scheduled event still to come");
  return d.minutesUntil!;
};

Given("a played game on a quiet morning with the in-game clock running", function () {
  const b = park(this, CLOCK.phaseStartsHour.morning);
  assert.ok(minutesToNextEvent(b.s!) >= 4 * 60, "nothing is scheduled before the afternoon");
});
Given("a played game on a quiet morning, {int} minutes before the afternoon", function (left: number) {
  const b = park(this, afternoon - left / 60);
  assert.equal(b.s!.gameStatus().timeOfDay, "morning");
  assert.ok(minutesToNextEvent(b.s!) >= left, "nothing is scheduled before the afternoon");
});
Given("a played game with the in-game clock running, {int} minutes before the next scheduled event", function (left: number) {
  const b = park(this, CLOCK.phaseStartsHour.morning);
  const until = minutesToNextEvent(b.s!);
  const s = b.s!;
  at(s, hourOf(s) + (until - left) / 60);
  b.startHour = hourOf(s); b.dueHour = b.startHour + left / 60;
  close(minutesToNextEvent(s), left, "minutes to the event");
  b.core = JSON.stringify(s.snapshot());
});

/** Run the hang-out from the parked moment; retry with the next side-stream roll while a roll stops it short of `expect` minutes for another reason. */
function waitFor(b: Bag, req: HangOutReq, expect: number, acceptStop: HangOutView["stopReason"][] = []): void {
  const s = b.s!;
  for (let k = 0; k < 40; k++) {
    s.restore(JSON.parse(b.core!) as SessionCore);
    at(s, b.startHour!);
    (priv(s).live as { hangOutCount?: number }).hangOutCount = k; // TEST-ONLY seam: picks the k-th side-stream roll (the rng is keyed on the count)
    b.t0 = hourOf(s);
    const r = s.hangOut(req);
    assert.equal(r.ok, true, `the hang-out was refused: ${r.reason}`);
    b.r = r;
    if (r.minutes >= expect || r.stopReason === "max-beats" || acceptStop.includes(r.stopReason)) return;
  }
  assert.fail("every hang-out roll was interrupted before the stated length");
}

When("the player says they will wait {int} minutes and nothing in the house interrupts them", function (m: number) {
  waitFor(bag(this), { maxMinutes: m }, Math.min(m, 180));
});
When("the player says they will wait out the rest of the morning and nothing in the house interrupts them", function () {
  const b = bag(this);
  waitFor(b, { untilBandEnd: true }, Math.min(180, Math.round((afternoon - b.startHour!) * 60))); // the three-hour cap applies to the rest of the band too
});
When("the player says they will wait {int} minutes or the rest of the morning and nothing in the house interrupts them", function (m: number) {
  const b = bag(this);
  waitFor(b, { maxMinutes: m, untilBandEnd: true }, Math.min(m, 180, Math.round((afternoon - b.startHour!) * 60)));
});
When("the player says they will wait {int} minutes for the event", function (m: number) {
  const b = bag(this);
  waitFor(b, { maxMinutes: m }, Math.round((b.dueHour! - b.startHour!) * 60), ["event-due"]);
});

Then("the in-game clock has moved on by exactly {int} minutes", function (m: number) {
  const b = bag(this);
  close((hourOf(b.s!) - b.t0!) * 60, m, "clock minutes");
  assert.equal(b.r!.minutes, m, "the hang-out's own minutes");
});
Then("the in-game clock stands at the start of the afternoon", function () {
  close(hourOf(bag(this).s!), afternoon, "the clock");
});
Then("the wait stopped because the event came due", function () {
  const b = bag(this);
  assert.equal(b.r!.stopReason, "event-due");
  close(hourOf(b.s!), b.dueHour!, "the clock stands at the event");
  assert.equal((b.s!.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due, true, "the event is due");
});
