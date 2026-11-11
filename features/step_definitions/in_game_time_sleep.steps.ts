import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolveCompetition, CompetitionIntents, type Competitor } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import {
  socialSwayScale, accrueFatigue, sleepDebtHours, sleepDeficitForBedHour, restStatusFor,
  isAwakeAtHour,
  eventSpanHours, eventStartHour, eventSpillsPeriod, WAKE_HOUR, DAY_END_HOUR, PERIOD_HOURS,
} from "../../src/engine/timeOfDay";
import { CLOCK, WEEKLY_CADENCE } from "../../src/engine/sleepConstants";
import { DAY_SCHEDULE } from "../../src/engine/daySchedule";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { linger } from "../../tests/support/linger";
import { resolvePending } from "../support/answerPending";

/**
 * Feature 0066 — in-game time of day & the nightly sleep economy (ADR 0006), the 24-HOUR model (#1125).
 * HARD rule: roles only — the player / a houseguest / a rested one / a tired one. The hidden sleep state is
 * the engine's; the player feels it only as later behavior + their own cue. Drives the LIVE adapter and
 * turns each opt-in flag on per scenario (default OFF).
 */

const PHASES = ["morning", "afternoon", "evening", "night", "late-night"];
const REST = ["rested", "tired", "running on empty"];
const SEED = 7;

/** Map a human bedtime label to a clock-HOUR (8..32; midnight = 24). */
const HOUR_OF: Record<string, number> = {
  "10pm": 22, "midnight": CLOCK.midnightHour, "2am": 26, "the 8am wake": DAY_END_HOUR,
};

function bag(w: BbWorld): NonNullable<BbWorld["sleep"]> {
  if (!w.sleep) w.sleep = {};
  return w.sleep;
}

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

function startSession(w: BbWorld): GameSessionAdapter {
  const b = bag(w);
  GameSessionAdapter.setTimeOfDayEnabled(b.clockEnabled ?? true);
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed: SEED });
  s.setPerConversationClockEnabled(b.perConversation ?? false);
  s.setSocialFatigueEnabled(b.socialFatigue ?? false);
  s.setMultiNightFatigueEnabled(b.multiNight ?? false);
  b.session = s;
  return s;
}

/** Advance (clock on) into the night until the house has THINNED (a strict subset awake). */
function advanceUntilThinned(s: GameSessionAdapter, cap = 40): boolean {
  for (let i = 0; i < cap; i++) {
    if (s.gameStatus().timeOfDay) {
      const ids = s.livingIds().filter((id) => id !== PLAYER);
      if (s.awakeAmong(ids).length < ids.length) return true;
      linger(s);
      if (s.awakeAmong(ids).length < ids.length) return true;
    }
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  return s.awakeAmong(ids).length < ids.length;
}

After(function () {
  GameSessionAdapter.setTimeOfDayEnabled(null);
  delete process.env.ORWELL_TIME_OF_DAY;
});

// --- Flags (Background + Phase-2 opt-ins) --------------------------------------------------------

Given("the in-game clock is enabled", function (this: BbWorld) { bag(this).clockEnabled = true; });
Given("the in-game clock is disabled", function (this: BbWorld) { bag(this).clockEnabled = false; });
Given("the per-conversation clock advance is enabled", function (this: BbWorld) { bag(this).perConversation = true; });
Given("NPC next-day social fatigue is enabled", function (this: BbWorld) { bag(this).socialFatigue = true; });
Given("the compounding multi-night fatigue meter is enabled", function (this: BbWorld) { bag(this).multiNight = true; });
Given("a live season", function (this: BbWorld) { startSession(this); });

// --- The 24-hour clock & the five periods ---------------------------------------------------------

When("the house plays through the day", function (this: BbWorld) {
  const b = bag(this);
  const s = b.session ?? startSession(this);
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) {
    const a = s.advanceGame();
    const tod = s.gameStatus().timeOfDay;
    if (tod) seen.add(tod);
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  b.phasesSeen = seen;
  b.timeOfDay = s.gameStatus().timeOfDay;
});

Then("the time of day advances through morning, afternoon, evening, night, and late-night", function (this: BbWorld) {
  const seen = bag(this).phasesSeen!;
  assert.ok(seen.size > 1, "the clock visibly advances through more than one phase");
  for (const p of seen) assert.ok(PHASES.includes(p), `'${p}' is a valid public phase`);
});

Then("the time of day is surfaced as a public, Vault-free read", function (this: BbWorld) {
  const s = bag(this).session!;
  const json = JSON.stringify(s.gameStatus());
  assert.ok(s.gameStatus().timeOfDay, "the public status carries a time of day");
  for (const banned of ["bedtime", "owlScore", "restPenalty", "lastSleepPhase", "playerRetired", "nightDepth", "fatigue"]) {
    assert.ok(!json.includes(banned), `no hidden sleep field '${banned}' leaks into the public read`);
  }
});

Then("the day spans the 8am wake to the next 8am", function () {
  assert.equal(WAKE_HOUR, 8, "the day begins at the 8am forced wake");
  assert.equal(DAY_END_HOUR, 32, "the day ends at the next 8am");
  assert.equal(DAY_END_HOUR - WAKE_HOUR, 24, "a day is 24 hours");
});

Then("the late-night block runs from midnight to the morning wake", function () {
  assert.equal(CLOCK.midnightHour, 24, "midnight is hour 24");
  assert.equal(DAY_END_HOUR - CLOCK.midnightHour, 8, "the late-night block is an 8-hour span (midnight→8am)");
});

// --- Symmetric sleep, wake, and the graded debt ---------------------------------------------------

Given("a houseguest who goes to bed at {word}", function (this: BbWorld, label: string) {
  bag(this).bedHour = HOUR_OF[label];
  assert.ok(bag(this).bedHour !== undefined, `known bedtime label '${label}'`);
});
// "the 8am wake" is multi-word — a dedicated pattern catches it (the {word} pattern won't).
Given("a houseguest who goes to bed at the 8am wake", function (this: BbWorld) {
  bag(this).bedHour = HOUR_OF["the 8am wake"];
});

Then("their sleep debt is {int} hours", function (this: BbWorld, debt: number) {
  assert.equal(sleepDebtHours(bag(this).bedHour!), debt, `bedtime hour ${bag(this).bedHour} ⇒ ${debt}h debt`);
});

Then("their own rest cue reads {word}", function (this: BbWorld, cue: string) {
  assert.equal(restStatusFor(bag(this).bedHour!), cue);
});
Then("their own rest cue reads running on empty", function (this: BbWorld) {
  assert.equal(restStatusFor(bag(this).bedHour!), "running on empty");
});

Given("a houseguest who goes to bed before midnight", function (this: BbWorld) {
  bag(this).bedHour = 22; // 10pm — a clear pre-midnight lark
});

Then("they sleep their full need and wake before the 8am forced wake", function (this: BbWorld) {
  const wake = bag(this).bedHour! + CLOCK.sleepNeedHours;
  assert.ok(wake < DAY_END_HOUR, "a pre-midnight bedtime finishes the 8h sleep before the 8am wake");
  assert.equal(isAwakeAtHour(bag(this).bedHour! + 2, bag(this).bedHour!), false, "asleep mid-night");
  assert.equal(isAwakeAtHour(wake, bag(this).bedHour!), true, "risen at their natural wake (pre-dawn)");
});

Then("they carry no sleep debt", function (this: BbWorld) {
  assert.equal(sleepDebtHours(bag(this).bedHour!), 0);
});

Then("they gain bonus awake time in the pre-dawn window", function (this: BbWorld) {
  const wake = bag(this).bedHour! + CLOCK.sleepNeedHours;
  assert.ok(DAY_END_HOUR - wake > 0, "there is awake time between their pre-dawn wake and the 8am forced wake");
});

Given("it is late at night", function (this: BbWorld) {
  const s = startSession(this);
  assert.ok(advanceUntilThinned(s), "the house thinned at night");
});

Then("the awake set is a strict subset of the house — some have turned in", function (this: BbWorld) {
  const s = bag(this).session!;
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  assert.ok(s.awakeAmong(ids).length < ids.length, "a strict subset is awake — some have turned in");
});

Then("the bidirectional ramp holds — pre-dawn risers wake while post-midnight owls stay asleep", function () {
  const lark = 22;  // beds 10pm → up again at 6am (hour 30)
  const owl = 26;   // beds 2am → asleep 26..32, no pre-dawn window
  assert.equal(isAwakeAtHour(30, lark), true, "the lark has risen pre-dawn");
  assert.equal(isAwakeAtHour(30, owl), false, "the owl is still asleep at 6am");
});

Then("the two late-night windows are distinct — costly owls versus free early risers", function () {
  assert.ok(sleepDeficitForBedHour(26) > 0, "the post-midnight owl pays a real deficit");
  assert.equal(sleepDeficitForBedHour(22), 0, "the pre-midnight early riser pays nothing");
});

// --- Sleep is consequential: comps, symmetric, never protective -----------------------------------

Given("two equally skilled houseguests", function (this: BbWorld) { bag(this); });
Given("one of them stayed up past midnight and the other was rested", function (this: BbWorld) { bag(this); });

When("they compete many times", function (this: BbWorld) {
  const N = 400;
  const rested: Competitor = { id: "rested", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 0 };
  const tired: Competitor = { id: "tired", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 1 };
  let restedWins = 0;
  for (let seed = 0; seed < N; seed++) {
    if (resolveCompetition([rested, tired], "mental", new CompetitionIntents(), new SeededRandom(seed)).winner === "rested") restedWins++;
  }
  bag(this).restedWinRate = restedWins / N;

  const favorite: Competitor = { id: "fav", stats: { physical: 0.9, mental: 0.9, social: 0.9 }, restPenalty: 1 };
  const challenger: Competitor = { id: "chl", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 0 };
  let favLost = false;
  for (let seed = 0; seed < N; seed++) {
    if (resolveCompetition([favorite, challenger], "mental", new CompetitionIntents(), new SeededRandom(seed)).winner !== "fav") { favLost = true; break; }
  }
  bag(this).favoriteCanLose = favLost;
});

Then("the rested houseguest wins a clear majority", function (this: BbWorld) {
  assert.ok(bag(this).restedWinRate! > 0.6, `rested wins a clear majority (got ${bag(this).restedWinRate})`);
});

Then("a tired favorite can still lose a competition they would otherwise win", function (this: BbWorld) {
  assert.ok(bag(this).favoriteCanLose, "a sufficiently tired favorite loses at least one comp");
});

Then("the sleep penalty is applied to every competitor by the same math", function () {
  const a: Competitor = { id: "a", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 1 };
  const b: Competitor = { id: "b", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 0 };
  const a2: Competitor = { id: "a", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 0 };
  const b2: Competitor = { id: "b", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 1 };
  let bWins = 0, aWins = 0;
  for (let seed = 0; seed < 300; seed++) {
    if (resolveCompetition([a, b], "mental", new CompetitionIntents(), new SeededRandom(seed)).winner === "b") bWins++;
    if (resolveCompetition([a2, b2], "mental", new CompetitionIntents(), new SeededRandom(seed)).winner === "a") aWins++;
  }
  assert.ok(bWins > 180 && aWins > 180, "the rested competitor is favored identically regardless of which side it is");
});

Then("the player is never special-cased", function () {
  const player: Competitor = { id: PLAYER, stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 1 };
  const npcC: Competitor = { id: "npc:1", stats: { physical: 0.5, mental: 0.5, social: 0.5 }, restPenalty: 1 };
  let playerWins = 0;
  for (let seed = 0; seed < 400; seed++) {
    if (resolveCompetition([player, npcC], "mental", new CompetitionIntents(), new SeededRandom(seed)).winner === PLAYER) playerWins++;
  }
  assert.ok(playerWins > 150 && playerWins < 250, `equal player/NPC is ~50/50, not protected (got ${playerWins}/400)`);
});

// --- The player's bedtime lever -------------------------------------------------------------------

Given("the player is up late", function (this: BbWorld) {
  const s = startSession(this);
  s.advanceGame(); // start the clock
});

When("the player turns in", function (this: BbWorld) { bag(this).session!.turnIn(); });

Then("the house rolls to the next morning", function (this: BbWorld) {
  assert.equal(bag(this).session!.gameStatus().timeOfDay, "morning", "turning in rolls to a fresh morning");
});

Then("an early night leaves the player rested for tomorrow", function (this: BbWorld) {
  assert.equal(bag(this).session!.getGameState().player?.restStatus, "rested", "an early night reads rested");
});

Then("the player is never auto-slept", function (this: BbWorld) {
  const s = bag(this).session ?? startSession(this);
  assert.ok((s.gameStatus().asleep ?? []).every((a) => a.id !== PLAYER), "the player is never auto-slept");
});

// --- The Vault Wall holds -------------------------------------------------------------------------

Then("the player sees their own qualitative rest cue, never a number", function (this: BbWorld) {
  const s = startSession(this);
  for (let i = 0; i < 6; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
  const cue = s.getGameState().player?.restStatus;
  assert.ok(cue !== undefined && REST.includes(cue), `the player's own cue is qualitative ('${cue}')`);
});

Then("no houseguest's sleep, bedtime, or rest deficit is ever exposed", function (this: BbWorld) {
  const s = bag(this).session!;
  const view = s.getGameState();
  assert.ok(view.house.every((c) => !("restStatus" in c)), "no NPC card carries a rest cue");
  const json = JSON.stringify(view.house);
  for (const banned of ["restStatus", "bedtime", "lastSleepPhase", "restPenalty", "playerRetired", "fatigue"]) {
    assert.ok(!json.includes(banned), `no NPC sleep field '${banned}' leaks`);
  }
});

// --- Dormant by default ---------------------------------------------------------------------------

Then("no time of day or rest cue is surfaced", function (this: BbWorld) {
  const s = bag(this).session ?? startSession(this);
  for (let i = 0; i < 6; i++) { const a = s.advanceGame(); if (a.pending) resolveLegally(s, a.pending); }
  assert.equal(s.gameStatus().timeOfDay, undefined, "no time of day when the clock is off");
  assert.equal(s.getGameState().player?.restStatus, undefined, "no rest cue when the clock is off");
});

// --- The weekly 5-cycle cadence + period placement ------------------------------------------------

Then("the week runs HOH, nominations, veto competition, veto ceremony, eviction in strict order", function () {
  assert.deepEqual([...WEEKLY_CADENCE.order],
    ["hoh", "nominations", "veto-draw", "veto-competition", "veto-ceremony", "eviction"]);
  let prevDay = 0;
  for (const beat of WEEKLY_CADENCE.order) {
    assert.ok(WEEKLY_CADENCE.dayOf[beat] >= prevDay, "the strict order respects the day sequence");
    prevDay = WEEKLY_CADENCE.dayOf[beat];
  }
});

Then("every day of the week carries a meaningful beat", function () {
  const days = new Set(Object.values(WEEKLY_CADENCE.dayOf));
  for (const d of [1, 2, 3, 4, 5]) assert.ok(days.has(d), `Day ${d} carries a beat (no default rest day)`);
});

Then("the HOH crowns in the morning, maximizing the post-HOH playable window", function () {
  // DAY_SCHEDULE is the one timetable: the HOH comp is scheduled for the afternoon (the house gets a morning to scramble first).
  assert.equal(DAY_SCHEDULE["hoh-competition"], "afternoon");
  assert.ok(CLOCK.phaseStartsHour.evening > CLOCK.phaseStartsHour.afternoon, "the day continues after the HOH");
});

Then("the veto competition runs in the afternoon", function () {
  assert.equal(DAY_SCHEDULE["veto-competition"], "afternoon");
  assert.equal(WEEKLY_CADENCE.dayOf["veto-draw"], WEEKLY_CADENCE.dayOf["veto-competition"]); // the player draw precedes it, same day
});

Then("the eviction runs in the evening", function () {
  assert.equal(DAY_SCHEDULE.eviction, "evening");
});

Then("the next HOH begins the morning after the eviction, not eviction night", function () {
  assert.equal(WEEKLY_CADENCE.dayOf.eviction, 5);
  assert.equal(DAY_SCHEDULE["hoh-competition"], "afternoon"); // the next reign's HOH comp is on the day after, in the DAY_SCHEDULE slot
});

// --- Event durations + seeded start-within-period + spillover -------------------------------------

Then("a competition runs about three hours, a ceremony about one, an eviction about two", function () {
  assert.equal(eventSpanHours("competition"), 3);
  assert.equal(eventSpanHours("ceremony"), 1);
  assert.equal(eventSpanHours("eviction"), 2);
});

Then("a beat starts at a seeded time within its period, not pinned to the edge", function () {
  const periodStart = CLOCK.phaseStartsHour.morning;
  const a = eventStartHour(periodStart, 7, "hoh:w1");
  assert.ok(a >= periodStart && a < periodStart + PERIOD_HOURS, "within the period");
  assert.notEqual(a, periodStart, "not pinned to the edge");
  assert.equal(eventStartHour(periodStart, 7, "hoh:w1"), a, "replay-stable per seed+beat");
  assert.notEqual(a, eventStartHour(periodStart, 7, "veto:w1"), "distinct beats start at distinct times");
});

Then("a long beat may spill into the next period", function () {
  const periodStart = CLOCK.phaseStartsHour.afternoon;
  assert.equal(eventSpillsPeriod(periodStart + 2, eventSpanHours("competition")), true, "a 3h comp starting 2h in spills");
});

Then("competitions vary in length by type", function () {
  assert.equal(eventSpanHours("competition", 5), 5);   // endurance long
  assert.equal(eventSpanHours("competition", 1.5), 1.5); // quick-fire short
  assert.notEqual(eventSpanHours("competition", 5), eventSpanHours("competition", 1.5));
});

// --- Conversation durations (LOOSE) ---------------------------------------------------------------

Then("an engaged scene is never cut short by the clock", function () {
  // The per-conversation advance only ADVANCES time AFTER a scene; it never ends one. The clock clamps at
  // the bitter pre-dawn edge under a long lingering run and NEVER wraps without the player's turnIn — so an
  // engaged scene can run as long as the player stays in it (ADR 0003 / the lull rule).
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed: SEED });
  s.setPerConversationClockEnabled(true);
  s.advanceGame(); // 0111: close the premiere champagne circle
  s.advanceGame(); // start the day (initializes the clock)
  // P4c: the clock ticks 5 minutes a message; across many messages it still clamps at late-night and never wraps without the player's own turnIn.
  for (let i = 0; i < 1000; i++) s.advanceClockPerConversation({ kind: "summit", proposedHours: 4 });
  assert.equal(s.gameStatus().timeOfDay, "late-night", "lingering clamps at late-night, never wrapping the night");
  assert.ok(!s.snapshot().live?.playerRetired, "the player is never auto-retired by an engaged scene");
  GameSessionAdapter.setTimeOfDayEnabled(null);
});

// --- Phase-2 Ext 1: per-conversation clock advance ------------------------------------------------

When("the player lingers and plays within a beat", function (this: BbWorld) {
  const s = bag(this).session!;
  s.advanceGame(); // 0111: close the premiere champagne circle
  s.advanceGame(); // start the day (initializes the clock)
  bag(this).depthBefore = s.snapshot().live?.nightDepth ?? 0;
  for (let i = 0; i < 20; i++) s.advanceClockPerConversation();
  bag(this).depthAfter = s.snapshot().live?.nightDepth ?? 0;
});

Then("the time of day presses forward as the player plays", function (this: BbWorld) {
  const b = bag(this);
  assert.ok(b.depthAfter! > b.depthBefore!, "lingering genuinely presses the clock forward");
});

Then("lingering never wraps the night past the player's own bedtime choice", function (this: BbWorld) {
  const s = bag(this).session!;
  // P4c: even across unbounded messages the clock clamps at late-night.
  for (let i = 0; i < 1000; i++) s.advanceClockPerConversation();
  assert.equal(s.gameStatus().timeOfDay, "late-night", "the per-conversation clock clamps at late-night, never wrapping");
  assert.ok(!s.snapshot().live?.playerRetired, "the player is never auto-retired by lingering");
});

// --- Phase-2 Ext 2: NPC next-day social fatigue ---------------------------------------------------

Then("a rested houseguest moves another's read at full strength", function () {
  assert.equal(socialSwayScale(0), 1, "a rested houseguest's fold is at full strength (scale 1)");
});

Then("a tired houseguest moves it less, but never to nothing", function () {
  const tired = socialSwayScale(1);
  assert.ok(tired < 1, "a tired houseguest sways less than a rested one");
  assert.ok(tired > 0, "but never to nothing — the sway is floored");
});

// --- Phase-2 Ext 3: compounding multi-night fatigue meter -----------------------------------------

Then("consecutive late nights stack a deeper deficit than a single one", function (this: BbWorld) {
  const n1 = accrueFatigue(0, 0.5);
  const n3 = accrueFatigue(accrueFatigue(n1, 0.5), 0.5);
  bag(this).fatigueN1 = n1;
  bag(this).fatigueN3 = n3;
  assert.ok(n3 > n1, "three late nights stack a deeper deficit than one");
});

Then("a rested night recovers part of the accumulated fatigue", function (this: BbWorld) {
  const recovered = accrueFatigue(bag(this).fatigueN3!, 0);
  assert.ok(recovered < bag(this).fatigueN3!, "a rested night recovers part of the accumulated fatigue");
  assert.ok(recovered >= 0, "recovery stays bounded at 0");
});

Then("the meter stays bounded and is never shown to the player", function () {
  assert.equal(accrueFatigue(1, 1), 1, "the meter saturates at 1 (bounded)");
});
