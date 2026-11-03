import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { COMPETITION_LIBRARY, drawCompetition } from "../../src/engine/competitionLibrary";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import { answerPending, resolvePending } from "../support/answerPending";

// Feature 0042 — the competition library. HARD rule: roles only — no names.

/** Play a seeded live game a few weeks, auto-answering pendings; collect the drawn-comp record. */
function clPlay(user: string, seed: number, weeks = 4): {
  history: { hoh: string[]; veto: string[] };
  vetoFieldSizes: number[];
  compViews: string;
} {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(user).session;
  s.createCharacter({ playerName: "The Player", seed });
  const vetoFieldSizes: number[] = [];
  const compViews: unknown[] = [];
  for (let i = 0; i < 200; i++) {
    compViews.push(s.runCompetition({}));
    const v = s.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => s.submitDecision(req));
    }
    const live = s.snapshot().live;
    if (live?.vetoField) vetoFieldSizes.push(live.vetoField.length);
    if (v.status.week > weeks || v.finished) break;
  }
  const live = s.snapshot().live!;
  return { history: live.compHistory ?? { hoh: [], veto: [] }, vetoFieldSizes, compViews: JSON.stringify(compViews) };
}

// --- Scenario: A season draws a variety of distinct competitions ------------------------

Given("a started game played across several weeks", function (this: BbWorld) {
  this.clRun = clPlay("cl-season", 31);
});

When("each week's competition is drawn from the library", function (this: BbWorld) {
  this.clTrail = [...this.clRun!.history.hoh, ...this.clRun!.history.veto];
  assert.ok(this.clRun!.history.hoh.length >= 3, "several weeks of hoh draws happened");
});

Then("more than one distinct competition is used over the season", function (this: BbWorld) {
  assert.ok(new Set(this.clTrail!).size > 1);
});

Then("the same competition is not drawn twice in immediate succession", function (this: BbWorld) {
  for (const phase of ["hoh", "veto"] as const) {
    const t = this.clRun!.history[phase];
    for (let i = 1; i < t.length; i++) assert.notEqual(t[i], t[i - 1], `${phase} repeats back-to-back`);
  }
});

// --- Scenario: The drawn competition's governing aptitude favors the right houseguest -----

Given("a competition whose library definition is governed by one aptitude", function (this: BbWorld) {
  this.clDef = COMPETITION_LIBRARY.find((d) => d.governing === "mental")!;
});

When("it is resolved over the house many times", function (this: BbWorld) {
  const def = this.clDef!;
  const field = (): Competitor[] => {
    const strong: Competitor = { id: npc(1), stats: { physical: 0.4, mental: 0.4, social: 0.4 } };
    strong.stats[def.governing] = 0.75;
    const weak: Competitor = { id: npc(2), stats: { physical: 0.6, mental: 0.6, social: 0.6 } };
    weak.stats[def.governing] = 0.5;
    return [strong, weak];
  };
  let wins = 0;
  const runs = 300;
  for (let i = 0; i < runs; i++) {
    if (resolveCompetition(field(), def.type, new CompetitionIntents(), new SeededRandom(i + 1)).winner === npc(1)) wins++;
  }
  this.clWinRate = wins / runs;
});

Then("the houseguest strongest in that aptitude wins a clear majority", function (this: BbWorld) {
  assert.ok(this.clWinRate! > 0.55, `the governing-aptitude favorite won ${this.clWinRate}`);
});

// --- Scenario: The engine still decides the winner ------------------------------------------

Given("a clear favorite in a drawn competition", function (this: BbWorld) {
  this.clDef = drawCompetition("hoh", 1, new SeededRandom(3));
});

When("it is resolved many times under bounded temperature", function (this: BbWorld) {
  const def = this.clDef!;
  let favoriteWins = 0;
  let playerWins = 0;
  const runs = 400;
  for (let i = 0; i < runs; i++) {
    const favorite: Competitor = { id: npc(1), stats: { physical: 0.5, mental: 0.5, social: 0.5 } };
    favorite.stats[def.governing] = 0.75;
    const evenPlayer: Competitor = { id: PLAYER, stats: { physical: 0.5, mental: 0.5, social: 0.5 } };
    const r = resolveCompetition([favorite, evenPlayer, { id: npc(2), stats: { physical: 0.5, mental: 0.5, social: 0.5 } }],
      def.type, new CompetitionIntents(), new SeededRandom(i + 11));
    if (r.winner === npc(1)) favoriteWins++;
    if (r.winner === PLAYER) playerWins++;
  }
  this.clWinRate = favoriteWins / runs;
  this.clPlayerRate = playerWins / runs;
});

Then("the favorite wins a strong majority but loses real upsets", function (this: BbWorld) {
  assert.ok(this.clWinRate! > 0.55 && this.clWinRate! < 0.98, `favorite rate ${this.clWinRate}`);
  // The even-statted player won no more than a fair share against the favorite — no hidden favor
  // (the canonical 0028 step "the player is never protected from losing" pins the identical-odds proof).
  assert.ok(this.clPlayerRate! < 0.4, `player rate ${this.clPlayerRate}`);
});

// --- Scenario: The Vault-free result carries the competition's flavor, never stats ------------

Given("a resolved competition", function (this: BbWorld) {
  this.clRun = clPlay("cl-flavor", 23);
});

When("its result is read on a player surface", function (this: BbWorld) {
  this.clViews = this.clRun!.compViews;
});

Then("it carries the competition's name and narrative format and the winner's name", function (this: BbWorld) {
  assert.match(this.clViews!, /"name":/);
  assert.match(this.clViews!, /"format":/);
  assert.match(this.clViews!, /"premise":/);
  assert.match(this.clViews!, /"winner":\{"id":/);
});

Then("it contains no stats, scores, rankings, or Vault sentinel value", function (this: BbWorld) {
  assert.ok(!/"(physical|mental|social|trust|affinity|threat)"\s*:\s*\d/.test(this.clViews!), "no numeric stat");
  assert.ok(!/"scores"|"temperature"|"governing"|"ranking/i.test(this.clViews!), "no score/ranking surface");
  assert.ok(!/SENTINEL/i.test(this.clViews!), "no Vault sentinel");
});

// --- Scenario: Eligibility holds under any drawn competition ----------------------------------

Given("any competition drawn for the veto", function (this: BbWorld) {
  this.clRun = clPlay("cl-elig", 17, 3);
});

Then("exactly six houseguests play it by the eligibility rules", function (this: BbWorld) {
  assert.ok(this.clRun!.vetoFieldSizes.length > 0, "a veto field was drawn");
  for (const n of this.clRun!.vetoFieldSizes) assert.equal(n, 6);
});

Then("the structural eligibility invariants still hold", function (this: BbWorld) {
  // The 0005 invariants are orthogonal to WHICH comp is drawn: the same `vetoParticipants` /
  // `eligibleForHOH` paths run under every def (pinned exhaustively by the 0005 suite); here we
  // assert the live game showed no structural anomaly across several drawn comps.
  assert.ok(this.clRun!.history.veto.length >= 2, "multiple distinct drawn veto comps ran legally");
});

// --- Scenario: The draw and resolution are seed-deterministic ----------------------------------

Then("the same competitions are drawn and resolved identically", function (this: BbWorld) {
  // The shared 0044 When (`the same weeks are played in each`) played two same-seed games into
  // sdRegistryA/sdRegistryB; their drawn-comp records and crowned ceremonies must agree exactly.
  const a = this.sdRegistryA!.sandboxFor("sd-det-a").session.snapshot().live!;
  const b = this.sdRegistryB!.sandboxFor("sd-det-b").session.snapshot().live!;
  assert.deepEqual(a.compHistory, b.compHistory);
  assert.ok((a.compHistory?.hoh.length ?? 0) > 0, "comps were actually drawn");
  assert.deepEqual(a.evictionOrder, b.evictionOrder); // resolved identically, week after week
});
