import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  resolveCompetition, CompetitionIntents,
} from "../../src/domain/competitionOutcome";
import type { Competitor, CompetitionType } from "../../src/domain/competitionOutcome";
import { rollFor, withinBounds } from "../../src/domain/temperature";
import { eligibleForHOH, selectableReplacements } from "../../src/domain/eligibility";
import type { WeekState } from "../../src/domain/eligibility";
import { PLAYER, npc } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { buildSandbox } from "../../tests/support/sandbox";
import { assertHardRulesSurviveTemperature } from "../support/eligibilityUnderTemperature";

const RUNS = 600;
const flat = (v: number): Competitor["stats"] => ({ physical: v, mental: v, social: v });

function week(over: Partial<WeekState> = {}): WeekState {
  return {
    houseguests: [PLAYER, ...Array.from({ length: 15 }, (_, i) => npc(i + 1))],
    player: PLAYER, hoh: npc(1), nominees: [npc(2), npc(3)], ...over,
  };
}

// --- Reproducible temperature roll across involved variables ------------------

Given("a gameplay moment with multiple involved variables", function (this: BbWorld) {
  this.variables = ["outcome", "expression", "npc-initiative", "which-secret-surfaces", "alliance-shift"];
});

When("the moment is resolved with a fixed seed", function (this: BbWorld) {
  this.rollA = rollFor(this.variables!, new SeededRandom(42));
  this.rollB = rollFor(this.variables!, new SeededRandom(42));
});

Then("a temperature roll is applied across those variables", function (this: BbWorld) {
  assert.deepEqual(Object.keys(this.rollA!).sort(), [...this.variables!].sort());
  assert.ok(Object.values(this.rollA!).every((v) => typeof v === "number"));
});

Then("resolving again with the same seed yields the identical outcome", function (this: BbWorld) {
  assert.deepEqual(this.rollA, this.rollB);
});

// --- Hard rules invariant under temperature -----------------------------------

Given("any temperature roll", function (this: BbWorld) {
  this.week = week({ outgoingHoh: npc(4), vetoWinner: npc(5) });
  this.sandbox = buildSandbox(1);
});

Then("eligibility rules and the Vault Wall still hold", function (this: BbWorld) {
  assert.ok(!eligibleForHOH(this.week!).includes(npc(4)), "outgoing-HOH rule holds");
  assert.ok(!selectableReplacements(this.week!).includes(npc(5)), "veto-winner-replacement rule holds");
  // A competition resolved over that field under a deafening temperature weight still never lets them back in.
  assertHardRulesSurviveTemperature(this.week!);
  // A resolved competition's result reaches the player stat-free: the Vault stays sealed after the roll too.
  this.sandbox!.competitionViewForPlayer();
  const out = this.sandbox!.allPlayerOutputs();
  for (const s of this.sandbox!.sentinels) assert.ok(!out.includes(s), "no Vault content leaks");
});

// --- Win rates reflect stats, never story / player protection ------------------

Given(
  "an endurance competition and a houseguest whose profile does not support endurance",
  function (this: BbWorld) {
    this.type = "endurance";
    this.target = npc(1);
    this.field = [
      { id: npc(1), stats: { physical: 0.2, mental: 0.5, social: 0.5 } },
      ...[2, 3, 4, 5, 6].map((i) => ({ id: npc(i), stats: { physical: 0.75, mental: 0.5, social: 0.5 } })),
    ];
  },
);

Given("the player competes in a competition type their stats do not favor", function (this: BbWorld) {
  this.type = "endurance";
  this.target = PLAYER;
  this.equivId = npc(20);
  this.field = [
    { id: PLAYER, stats: { physical: 0.3, mental: 0.5, social: 0.5 } },
    { id: npc(20), stats: { physical: 0.3, mental: 0.5, social: 0.5 } }, // an NPC of equivalent stats
    ...[2, 3, 4, 5].map((i) => ({ id: npc(i), stats: flat(0.6) })),
  ];
});

Given("a clear favorite by stats in a competition", function (this: BbWorld) {
  this.type = "endurance";
  this.target = npc(1);
  this.field = [
    { id: npc(1), stats: flat(0.9) },
    ...[2, 3, 4, 5, 6].map((i) => ({ id: npc(i), stats: flat(0.5) })),
  ];
});

When("outcomes are computed across many seeded runs", function (this: BbWorld) {
  const wins: Record<string, number> = {};
  for (const c of this.field!) wins[c.id] = 0;
  for (let s = 1; s <= RUNS; s++) {
    const r = resolveCompetition(this.field!, this.type!, new CompetitionIntents(), new SeededRandom(s));
    wins[r.winner] = (wins[r.winner] ?? 0) + 1;
  }
  this.winRates = Object.fromEntries(Object.entries(wins).map(([k, v]) => [k, v / RUNS]));
});

Then(
  "that houseguest's win rate reflects stats and temperature, not story convenience",
  function (this: BbWorld) {
    assert.ok(this.winRates![this.target!]! < 0.2, "a houseguest weak in the type rarely wins");
  },
);

Then("the player's win rate reflects their stats like any other houseguest", function (this: BbWorld) {
  const diff = Math.abs(this.winRates![PLAYER]! - this.winRates![this.equivId!]!);
  assert.ok(diff <= 0.06, `player not protected: |${this.winRates![PLAYER]} - ${this.winRates![this.equivId!]}| = ${diff}`);
});

Then("the favorite wins the clear majority of runs", function (this: BbWorld) {
  assert.ok(this.winRates![this.target!]! >= 0.65, `favorite win rate ${this.winRates![this.target!]}`);
});

Then("the favorite still loses a real minority of runs", function (this: BbWorld) {
  assert.ok(1 - this.winRates![this.target!]! >= 0.1, "upsets are real");
});

// --- Intent honored + immutable -----------------------------------------------

Given(
  "the player declares an intent of compete, throw, or play safe before a competition",
  function (this: BbWorld) {
    this.intents = new CompetitionIntents();
    this.intents.declare(PLAYER, "throw");
    this.type = "endurance";
    this.field = [
      { id: PLAYER, stats: flat(0.9) }, // strong, but throwing
      ...[2, 3, 4, 5, 6].map((i) => ({ id: npc(i), stats: flat(0.5) })),
    ];
  },
);

When("the outcome is computed", function (this: BbWorld) {
  this.result = resolveCompetition(this.field!, this.type!, this.intents!, new SeededRandom(1));
});

Then("the declared intent affects the computation", function (this: BbWorld) {
  const scores = this.result!.scores;
  const min = Math.min(...Object.values(scores));
  assert.equal(scores[PLAYER], min, "throwing tanks the player's score");
  assert.notEqual(this.result!.winner, PLAYER, "a thrown comp is not won");
});

Then("the intent cannot be changed after the result is given", function (this: BbWorld) {
  assert.throws(() => this.intents!.declare(PLAYER, "compete"), /immutable/);
});

// --- Temperature bounds (reuses the 0003 "simulated with seed" Given) ----------

Then("every temperature roll falls within the configured bounds", function (this: BbWorld) {
  const rng = new SeededRandom(this.seed!);
  for (let i = 0; i < 500; i++) {
    const roll = rollFor(["outcome", "expression", "initiative", "surfacing"], rng);
    for (const v of Object.values(roll)) assert.ok(withinBounds(v), `temperature ${v} out of bounds`);
  }
});
