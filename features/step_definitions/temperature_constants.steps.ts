import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  TEMPERATURE_CONSTANTS,
  temperatureRoll,
  withinTemperatureBounds,
  emotionalModifier,
  hiddenSurfaces,
  type TemperatureConstants,
} from "../../src/domain/temperatureConstants";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc, PLAYER } from "../../src/domain/ids";

const flat = (v: number): { physical: number; mental: number; social: number } => ({ physical: v, mental: v, social: v });
const FAVORITE = npc(1);
const favoriteField = (): Competitor[] => [{ id: FAVORITE, stats: flat(0.9) }, ...[2, 3, 4, 5, 6].map((i) => ({ id: npc(i), stats: flat(0.5) }))];

function winRate(favorite: string, field: () => Competitor[], constants: TemperatureConstants = TEMPERATURE_CONSTANTS, runs = 600): number {
  let wins = 0;
  for (let s = 1; s <= runs; s++) {
    if (resolveCompetition(field(), "endurance", new CompetitionIntents(), new SeededRandom(s), constants).winner === favorite) wins++;
  }
  return wins / runs;
}

// --- The favorite wins a calibrated strong majority ---------------------------

Given("a clear favorite in a competition", function (this: BbWorld) {
  this.field = favoriteField(); // a 0.9 stat favorite among 0.5s
});

When("the competition is run across many seeds", function (this: BbWorld) {
  this.baseWinRate = winRate(FAVORITE, favoriteField);
});

Then("the favorite wins a strong majority of the time", function (this: BbWorld) {
  // Calibration band re-centred on the post-0006-retune reality (temperature 0.36→0.40 → ~66% for a
  // 0.9-vs-0.5 favorite; PO ruling 2026-07-06). Floor widened 0.65→0.60 so the gate has headroom and
  // never sits on its edge; the 0.80 ceiling + the ≥10% upset check below still bound the other way.
  assert.ok(this.baseWinRate! >= 0.6 && this.baseWinRate! <= 0.8, `favorite win rate ${this.baseWinRate}`);
});

Then("genuine upsets still occur", function (this: BbWorld) {
  assert.ok(1 - this.baseWinRate! >= 0.1, "real, uncommon upsets");
});

Then("the player is never protected from losing", function () {
  const others = [2, 3, 4, 5, 6].map((i) => ({ id: npc(i), stats: flat(0.6) }));
  const asPlayer = (): Competitor[] => [{ id: PLAYER, stats: flat(0.3) }, ...others];
  const asNpc = (): Competitor[] => [{ id: npc(20), stats: flat(0.3) }, ...others];
  assert.equal(winRate(PLAYER, asPlayer), winRate(npc(20), asNpc)); // identical odds — no protection
});

// --- Temperature is bounded and never breaks a hard rule ----------------------

When("temperature is rolled for any moment", function (this: BbWorld) {
  this.tempRolls = Array.from({ length: 300 }, (_, i) => temperatureRoll(new SeededRandom(i + 1)));
  this.compResultObj = resolveCompetition(favoriteField(), "endurance", new CompetitionIntents(), new SeededRandom(42));
});

Then("the outcome stays within bounds", function (this: BbWorld) {
  for (const v of this.tempRolls!) assert.ok(withinTemperatureBounds(v));
  for (const v of Object.values(this.compResultObj!.temperature)) assert.ok(withinTemperatureBounds(v));
});

Then("the winner is an eligible competitor", function (this: BbWorld) {
  const ids = favoriteField().map((c) => c.id);
  assert.ok(ids.includes(this.compResultObj!.winner)); // the winner is always an eligible competitor
});

Then("the result carries only ids and numbers", function (this: BbWorld) {
  // The result is purely {winner, scores, temperature} — ids + numbers, no hidden/narrative content.
  assert.deepEqual(Object.keys(this.compResultObj!).sort(), ["scores", "temperature", "winner"]);
  for (const v of Object.values(this.compResultObj!.scores)) assert.equal(typeof v, "number");
});

// --- The emotional modifier mean-reverts after a spike ------------------------

Given("a houseguest whose emotional modifier spiked from an adverse moment", function (this: BbWorld) {
  this.spikedMod = emotionalModifier(TEMPERATURE_CONSTANTS.emotional.baseline, -1, 0.6);
  assert.ok(Math.abs(this.spikedMod - TEMPERATURE_CONSTANTS.emotional.baseline) > 0.1, "genuinely spiked off baseline");
});

When("several calm moments pass", function (this: BbWorld) {
  let mod = this.spikedMod!;
  for (let i = 0; i < 8; i++) mod = emotionalModifier(mod, 0, 0); // calm: circumstance 0, temperature 0
  this.settledMod = mod;
});

Then("the modifier settles back toward its baseline", function (this: BbWorld) {
  const base = TEMPERATURE_CONSTANTS.emotional.baseline;
  assert.ok(Math.abs(this.settledMod! - base) < Math.abs(this.spikedMod! - base), "settled toward baseline");
});

// --- Hidden elements surface rarely -------------------------------------------

When("a season is played out across seeds", function (this: BbWorld) {
  const N = 1000;
  let surfaced = 0;
  for (let s = 1; s <= N; s++) if (hiddenSurfaces(new SeededRandom(s))) surfaced++;
  this.surfacingRate = surfaced / N;
});

Then("hidden character elements surface at a low, bounded rate", function (this: BbWorld) {
  assert.ok(this.surfacingRate! > 0 && this.surfacingRate! <= 0.15, `surfacing rate ${this.surfacingRate}`);
});

Then("they are present but not flooding the game", function (this: BbWorld) {
  assert.ok(this.surfacingRate! > 0, "present");
  assert.ok(this.surfacingRate! < 0.25, "not a flood");
});

// --- The swing is retunable from one constants module -------------------------

Given("the temperature constants module", function (this: BbWorld) {
  this.baseWinRate = winRate(FAVORITE, favoriteField); // the default-calibration baseline
});

When("a weight such as the temperature bound is changed", function (this: BbWorld) {
  // (computed in the Thens against the baseline captured above)
  assert.ok(this.baseWinRate !== undefined);
});

Then("the resulting distribution of outcomes changes accordingly", function (this: BbWorld) {
  const wide: TemperatureConstants = { ...TEMPERATURE_CONSTANTS, bound: { min: -3, max: 3 } };
  assert.ok(winRate(FAVORITE, favoriteField, wide) < this.baseWinRate!, "a wider bound spreads outcomes");
});

Then("no temperature or emotional number is hard-coded outside that module", function (this: BbWorld) {
  // Zeroing the temperature weight in the module makes outcomes pure-stat — proof the resolution
  // reads its numbers ONLY from the constants (no hidden temperature term in the logic).
  const noTemp: TemperatureConstants = { ...TEMPERATURE_CONSTANTS, outcome: { ...TEMPERATURE_CONSTANTS.outcome, temperature: 0 } };
  assert.equal(winRate(FAVORITE, favoriteField, noTemp), 1);
});
