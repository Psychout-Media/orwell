import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { npc } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { answerPending, resolvePending } from "../support/answerPending";

// Feature 0127 — mixed-type competitions. HARD rule: roles only — no names.

/** Win rate of npc(1) over a hybrid physical/mental comp across `runs` seeds. */
function hybridWinRate(field: () => Competitor[], secondary: "physical" | "mental" | "social" | undefined, runs = 400): number {
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    if (resolveCompetition(field(), "physical", new CompetitionIntents(), new SeededRandom(i + 1), undefined, secondary).winner === npc(1)) wins++;
  }
  return wins / runs;
}

/** Answer whatever pending the live game raises with a legal, deterministic choice (roles only). */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

/** Play a seeded game to completion with hybrid resolution on/off; return the eviction order. */
function mixPlay(user: string, seed: number, mixedOn: boolean): readonly string[] {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(user).session;
  s.createCharacter({ playerName: "The Player", seed });
  s.setCompMixedEnabled(mixedOn);
  for (let i = 0; i < 2000; i++) {
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  return s.snapshot().live?.evictionOrder ?? [];
}

// --- Scenario: A hybrid competition rewards the well-rounded houseguest --------------------

Given("two houseguests equally strong in a competition's primary aptitude", function (this: BbWorld) {
  this.mix = {};
});

Given("one of them is also strong in the competition's secondary aptitude", function (this: BbWorld) {
  const field = (): Competitor[] => [
    { id: npc(1), stats: { physical: 0.7, mental: 0.7, social: 0.5 } }, // equal physical, strong mental
    { id: npc(2), stats: { physical: 0.7, mental: 0.3, social: 0.5 } }, // equal physical, weak mental
  ];
  this.mix!.pureRate = hybridWinRate(field, undefined);
  this.mix!.hybridRate = hybridWinRate(field, "mental");
});

When("the hybrid competition is resolved many times", function () {
  // Resolution already run in the Given (win rates captured).
});

Then("the well-rounded houseguest wins more often than the one-dimensional one", function (this: BbWorld) {
  assert.ok(this.mix!.pureRate! > 0.4 && this.mix!.pureRate! < 0.6, "even primary ⇒ ~coin flip on a pure comp");
  assert.ok(this.mix!.hybridRate! > this.mix!.pureRate! + 0.15, "the secondary element tips it to the all-rounder");
});

// --- Scenario: The primary aptitude still dominates ----------------------------------------

Given("a houseguest who is a monster in the primary aptitude but weak in the secondary", function (this: BbWorld) {
  this.mix = {};
});

Given("a rival who is the reverse", function (this: BbWorld) {
  const field = (): Competitor[] => [
    { id: npc(1), stats: { physical: 0.9, mental: 0.2, social: 0.5 } },
    { id: npc(2), stats: { physical: 0.2, mental: 0.9, social: 0.5 } },
  ];
  this.mix!.hybridRate = hybridWinRate(field, "mental");
});

Then("the primary-aptitude houseguest still wins a strong majority", function (this: BbWorld) {
  assert.ok(this.mix!.hybridRate! > 0.6, `primary should dominate; won ${this.mix!.hybridRate}`);
});

// --- Scenario: With hybrid resolution off the season is byte-identical ----------------------

Given("two games started from the same seed played with hybrid resolution off", function (this: BbWorld) {
  this.mix = {};
});

When("each hybrid game is played to completion", function (this: BbWorld) {
  this.mix!.a = mixPlay("mix-off-a", 77, false);
  this.mix!.b = mixPlay("mix-off-b", 77, false);
});

Then("the same houseguests are evicted in identical order in each hybrid game", function (this: BbWorld) {
  assert.deepEqual(this.mix!.a, this.mix!.b);
  assert.ok((this.mix!.a?.length ?? 0) > 0, "houseguests were evicted");
});

// --- Scenario: Turning hybrid resolution on changes seeded outcomes ------------------------

Given("a set of seeds played once with hybrid resolution on and once off", function (this: BbWorld) {
  this.mix = {};
});

When("each pair of games is played to completion", function (this: BbWorld) {
  let diverged = false;
  for (const seed of [7, 31, 77, 108, 202]) {
    const on = mixPlay(`mix-on-${seed}`, seed, true);
    const off = mixPlay(`mix-cmp-${seed}`, seed, false);
    if (JSON.stringify(on) !== JSON.stringify(off)) { diverged = true; break; }
  }
  this.mix!.diverged = diverged;
});

Then("at least one season's eviction order diverges between on and off", function (this: BbWorld) {
  assert.ok(this.mix!.diverged, "hybrid resolution never changed any seeded season — the flag is inert");
});

// --- Scenario: Hybrid resolution never leaks a stat or score -------------------------------

Given("a resolved competition under hybrid resolution", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor("mix-wall").session;
  s.createCharacter({ playerName: "The Player", seed: 5 });
  s.setCompMixedEnabled(true);
  const views: unknown[] = [];
  for (let i = 0; i < 240; i++) {
    views.push(s.runCompetition({}));
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.status.week > 4 || a.finished) break;
  }
  this.mix = { views: JSON.stringify(views) };
});

When("the competition result is read on a player surface", function (this: BbWorld) {
  assert.ok((this.mix!.views?.length ?? 0) > 0, "a competition resolved");
});

Then("the hybrid result contains no stat, score, ranking, or Vault sentinel", function (this: BbWorld) {
  const blob = this.mix!.views!;
  assert.ok(!/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(blob), "no numeric stat");
  assert.ok(!/"scores"|"temperature"|"governing"|"ranking/i.test(blob), "no score/ranking surface");
  assert.ok(!/SENTINEL/i.test(blob), "no Vault sentinel");
});
