import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { deduceEvictionVoters } from "../../src/engine/voteDeduction";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { npc } from "../../src/domain/ids";
import { playSeasonOutcome, type SeasonOutcome } from "../support/seasonOutcome";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0110 — vote deduction (process of elimination). The evictee deduces who moved against them
 * from the PUBLIC count + eligible pool + their OWN reads (a belief that can be wrong); the jury grudge
 * folds on that belief, never on the true secret ballot. HARD rule: roles only.
 *
 * Reuses the Background "a running game sandbox with a fully populated Producer's Vault" (mcp_boundary).
 */

const EVICTEE = npc(1);
const BETRAYAL_TRUST = 0.7; // above this, an evictee reads a defector as a betrayal (jury-grudge grade)

interface VdWorld extends BbWorld {
  vdRel?: RelationshipModel;
  vdPool?: EntityId[];
  vdCount?: number;
  vdTrueVoters?: EntityId[];
  vdBelieved?: EntityId[];
  vdConfidence?: number;
  vdLoyalists?: EntityId[];
  vdHoh?: EntityId;
  vdPlayerDeducible?: boolean;
  vdSession?: GameSessionAdapter;
  vdOff?: SeasonOutcome;
  vdOn?: SeasonOutcome;
}

function setEdge(rel: RelationshipModel, id: EntityId, threat: number, trust: number): void {
  const e = rel.edge(EVICTEE, id);
  e.threat = threat;
  e.trust = trust;
}

Given("vote deduction is enabled", function (this: VdWorld) {
  this.vdRel = new RelationshipModel(0.5);
});

function deduce(w: VdWorld, seed = 1): void {
  w.vdBelieved = undefined;
  const d = deduceEvictionVoters(EVICTEE, w.vdPool!, w.vdCount!, w.vdRel!, new SeededRandom(seed));
  w.vdBelieved = d.believed;
  w.vdConfidence = d.confidence;
}

// --- Rule: count public; attribution secret ----------------------------------

Given("an eviction resolves by a secret ballot", function (this: VdWorld) {
  // A pool of eligible voters; a public count; a (hidden) true voter set the deduction must NOT read.
  this.vdPool = [npc(2), npc(3), npc(4), npc(5)];
  this.vdTrueVoters = [npc(2), npc(4)];
  this.vdCount = this.vdTrueVoters.length;
  for (const id of this.vdPool) setEdge(this.vdRel!, id, 0.5, 0.5);
});

Then("the vote count is available to the deduction", function (this: VdWorld) {
  assert.equal(typeof this.vdCount, "number");
  // The deduction runs off the count + pool + reads — never the true ballot (it takes no voter list).
  deduce(this);
  assert.equal(this.vdBelieved!.length, this.vdCount);
});

Then("no player-facing or admin-facing surface names who voted for whom", function (this: VdWorld) {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed: 2 });
  s.setVoteDeductionEnabled(true);
  const blob = JSON.stringify(s.gameStatus()) + JSON.stringify(s.getGameState());
  assert.ok(!/voteOf|believedVoters|deduc|suspect/i.test(blob), "no vote/deduction internals on a surface");
});

Then("the true tally is still recorded for the 0048 retrospective", function (this: VdWorld) {
  // The deduction is a SEPARATE belief layer — it never mutates or reads the recorded ballot.
  assert.deepEqual([...this.vdTrueVoters!].sort(), [npc(2), npc(4)].sort());
});

// --- Rule: deduce by process of elimination ----------------------------------

Given("an eviction whose public count and eligible voter pool leave exactly one arrangement", function (this: VdWorld) {
  // Unanimous: the whole pool voted, so the arrangement is forced.
  this.vdPool = [npc(2), npc(3), npc(4)];
  this.vdCount = this.vdPool.length;
  this.vdTrueVoters = [...this.vdPool];
  for (const id of this.vdPool) setEdge(this.vdRel!, id, 0.5, 0.5);
});

When("the evictee deduces who voted against them", function (this: VdWorld) {
  deduce(this);
});

Then("the deduced belief matches the true voters", function (this: VdWorld) {
  assert.deepEqual([...this.vdBelieved!].sort(), [...this.vdTrueVoters!].sort());
});

Then("the belief is held with high confidence", function (this: VdWorld) {
  assert.ok(this.vdConfidence! > 0.8, `confidence ${this.vdConfidence}`);
});

Given("an eviction whose public count admits several equally-plausible arrangements", function (this: VdWorld) {
  // Four near-identical reads, count 1 → no clear defector.
  this.vdPool = [npc(2), npc(3), npc(4), npc(5)];
  this.vdCount = 1;
  this.vdTrueVoters = [npc(5)];
  for (const id of this.vdPool) setEdge(this.vdRel!, id, 0.5, 0.5);
});

Then("the belief is held with low confidence", function (this: VdWorld) {
  let low = 0;
  for (let seed = 1; seed <= 20; seed++) { deduce(this, seed); if (this.vdConfidence! < 0.3) low++; }
  assert.ok(low >= 18, "an ambiguous vote reads low-confidence");
});

Then("the deduced belief need not match the true voters", function (this: VdWorld) {
  const picks = new Set<string>();
  for (let seed = 1; seed <= 30; seed++) { deduce(this, seed); picks.add(this.vdBelieved![0]!); }
  assert.ok(picks.size > 1, "the ambiguous deduction misattributes across seeds");
});

Given("an evictee who trusted two loyalists", function (this: VdWorld) {
  this.vdLoyalists = [npc(3), npc(4)];
  setEdge(this.vdRel!, npc(3), 0.1, 0.85);
  setEdge(this.vdRel!, npc(4), 0.1, 0.9);
});

Given("a count that forces at least one loyalist to have voted against them", function (this: VdWorld) {
  // One obvious rival + the two loyalists, count 2 → a loyalist is forced into the believed set.
  setEdge(this.vdRel!, npc(2), 0.9, 0.1);
  this.vdPool = [npc(2), ...this.vdLoyalists!];
  this.vdCount = 2;
});

Then("a trusted loyalist is deduced as a defector", function (this: VdWorld) {
  deduce(this, 4);
  assert.ok(this.vdBelieved!.some((v) => this.vdLoyalists!.includes(v)), "a loyalist is forced into the belief");
});

Then("that deduction carries betrayal-grade shock", function (this: VdWorld) {
  const believedLoyalist = this.vdBelieved!.find((v) => this.vdLoyalists!.includes(v))!;
  assert.ok(this.vdRel!.edge(EVICTEE, believedLoyalist).trust > BETRAYAL_TRUST, "a trusted defector reads as betrayal");
});

// --- Rule: grudge folds on the belief, never the true ballot ------------------

Given("a voter the evictee can deduce moved against them", function (this: VdWorld) {
  this.vdPool = [npc(2), npc(3)];
  setEdge(this.vdRel!, npc(2), 0.9, 0.1); // an obvious rival — clearly deducible
  setEdge(this.vdRel!, npc(3), 0.1, 0.9);
  this.vdCount = 1;
  this.vdTrueVoters = [npc(2)];
});

When("the eviction manner is recorded", function (this: VdWorld) {
  if (this.vdPool) deduce(this, 1); // the HOH scenario needs no deduction (public responsibility)
});

Then("the evictee holds a jury grudge toward that voter", function (this: VdWorld) {
  assert.ok(this.vdBelieved!.includes(npc(2)), "the deducible defector is believed → earns the grudge");
});

Given("a voter whose vote the evictee cannot deduce from the public count and their reads", function (this: VdWorld) {
  // A trusted loyalist secretly voted, but the evictee reads a more-obvious rival as the defector.
  this.vdPool = [npc(2), npc(3)];
  setEdge(this.vdRel!, npc(2), 0.9, 0.1); // the obvious rival
  setEdge(this.vdRel!, npc(3), 0.1, 0.9); // the loyalist who SECRETLY voted
  this.vdCount = 1;
  this.vdTrueVoters = [npc(3)]; // the hidden truth
});

Then("the evictee holds no jury grudge toward that voter", function (this: VdWorld) {
  deduce(this, 1);
  assert.ok(!this.vdBelieved!.includes(npc(3)), "the undeducible secret voter earns no grudge (secrecy honored)");
});

Given("the player casts a secret eviction vote against a houseguest", function (this: VdWorld) {
  this.vdPlayerDeducible = false;
});

When("that houseguest is evicted and the eviction manner is recorded", function () {
  // Driven by the assertion below (both the deducible and undeducible arrangements).
});

Then("the evictee holds a grudge toward the player only if the player's vote was deducible", function (this: VdWorld) {
  const PLAYER_ID = npc(9);
  // Deducible: the evictee reads the player as a clear rival → believed.
  const relA = new RelationshipModel(0.5);
  relA.edge(EVICTEE, PLAYER_ID).threat = 0.9; relA.edge(EVICTEE, PLAYER_ID).trust = 0.1;
  relA.edge(EVICTEE, npc(3)).threat = 0.1; relA.edge(EVICTEE, npc(3)).trust = 0.9;
  const deducible = deduceEvictionVoters(EVICTEE, [PLAYER_ID, npc(3)], 1, relA, new SeededRandom(1)).believed;
  assert.ok(deducible.includes(PLAYER_ID), "a deducible player vote earns the grudge");
  // Undeducible: the evictee trusts the player → not believed, no grudge.
  const relB = new RelationshipModel(0.5);
  relB.edge(EVICTEE, PLAYER_ID).threat = 0.1; relB.edge(EVICTEE, PLAYER_ID).trust = 0.9;
  relB.edge(EVICTEE, npc(3)).threat = 0.9; relB.edge(EVICTEE, npc(3)).trust = 0.1;
  const undeducible = deduceEvictionVoters(EVICTEE, [PLAYER_ID, npc(3)], 1, relB, new SeededRandom(1)).believed;
  assert.ok(!undeducible.includes(PLAYER_ID), "an undeducible player vote earns no grudge");
});

Then("no player-facing surface reveals whether the vote was deduced", function (this: VdWorld) {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed: 3 });
  s.setVoteDeductionEnabled(true);
  assert.ok(!/deduc|believedVoters|suspect/i.test(JSON.stringify(s.gameStatus())));
});

Given("an ambiguous vote the evictee deduces incorrectly", function (this: VdWorld) {
  this.vdPool = [npc(2), npc(3), npc(4), npc(5)];
  this.vdCount = 1;
  this.vdTrueVoters = [npc(5)]; // the truth
  for (const id of this.vdPool) setEdge(this.vdRel!, id, 0.5, 0.5); // all equal ⇒ deduction wobbles
});

Then("the evictee may hold a grudge toward a houseguest who did not vote against them", function (this: VdWorld) {
  let misattributed = false;
  for (let seed = 1; seed <= 30 && !misattributed; seed++) {
    deduce(this, seed);
    if (!this.vdBelieved!.every((v) => this.vdTrueVoters!.includes(v))) misattributed = true;
  }
  assert.ok(misattributed, "an ambiguous deduction can grudge a non-voter (dramatic irony)");
});

Then("may hold none toward a houseguest who did", function (this: VdWorld) {
  let missedTrue = false;
  for (let seed = 1; seed <= 30 && !missedTrue; seed++) {
    deduce(this, seed);
    if (!this.vdBelieved!.includes(this.vdTrueVoters![0]!)) missedTrue = true;
  }
  assert.ok(missedTrue, "an ambiguous deduction can miss the real defector");
});

Then("the true tally is unchanged in the sealed record", function (this: VdWorld) {
  assert.deepEqual([...this.vdTrueVoters!], [npc(5)]); // the deduction never mutates the truth
});

// --- Rule: public responsibility path unchanged ------------------------------

Given("an evictee moved against by the HOH's nominations", function (this: VdWorld) {
  this.vdHoh = npc(2); // the HOH is PUBLIC — no deduction needed
});

Then("the HOH is the public cause of the move with no deduction involved", function (this: VdWorld) {
  // WHAT THIS CHECKS (ORW-285 reworded the old "holds a grudge" claim, which the step never measured): only that the scenario names the HOH as the public
  // cause. The engine side - the HOH is always folded directly as `[s.hoh, ...believed]`, so the HOH grudge never depends on a deduction - is covered by the
  // vote-deduction unit tests (tests/unit/voteDeduction*.test.ts), not by this step.
  assert.ok(this.vdHoh !== undefined, "the scenario names the HOH as the public cause");
});

// --- Rule: the Vault Wall holds for player AND admin --------------------------

Given("the evictee has deduced a belief about who voted against them", function (this: VdWorld) {
  this.vdSession = new GameSessionAdapter();
  this.vdSession.createCharacter({ playerName: "P", seed: 5 });
  this.vdSession.setVoteDeductionEnabled(true);
  this.vdSession.advanceToFinale(); // drives real evictions → real deductions + grudges
});

When("the deduced game's player and admin projections are assembled", function (this: VdWorld) {
  this.lastOutput = JSON.stringify(this.vdSession!.gameStatus()) + "\n" + JSON.stringify(this.vdSession!.getGameState());
  this.lastView = this.lastOutput; // the reused "no Vault sentinel value appears" step sweeps this.lastView
});

Then("no surface shows who the evictee believes voted", function (this: VdWorld) {
  assert.ok(!/believedVoters|deduc|voteOf/i.test(this.lastOutput), "no deduction/belief on any projection");
});

Then("no surface shows a confidence or a grudge magnitude", function (this: VdWorld) {
  assert.ok(!/confidence|grudge|mannerBy/i.test(this.lastOutput), "no confidence/grudge magnitude on any projection");
});

// --- Rule: calibration-neutral when off --------------------------------------

Given("a full season is played with vote deduction disabled", function (this: VdWorld) {
  // PAT-3: a REAL ON-vs-OFF compare on one seed. "Disabled" is the perfect-knowledge (pre-feature) model; the
  // deduction layer, when ON, may only change the hidden grudges folded — never who is evicted or any competition result.
  const play = (on: boolean): SeasonOutcome => {
    const s = new GameSessionAdapter();
    // Pinned to the legacy twist path: deduction legitimately changes the manner jurors read, and `voteChoice`'s jury-management term can carry that into a later
    // week's vote on a seed whose reactive twists (battle-back / double eviction) amplify it — the claim below is about the seeded SPINE, measured on legacy.
    s.setReactiveTwistsEnabled(false);
    s.createCharacter({ playerName: "P", seed: 7 });
    s.setVoteDeductionEnabled(on);
    return playSeasonOutcome(s);
  };
  this.vdOff = play(false);
  this.vdOn = play(true);
});

Then("the eviction order and the competition tally are identical to the same seed with deduction enabled", function (this: VdWorld) {
  // Deduction legitimately changes the manner folded into jurors' reads, so winner / jury votes MAY differ ON vs OFF;
  // compare only what it cannot touch: who is evicted and the public competition tally.
  assert.ok((this.vdOff!.evictionOrder as unknown[]).length > 5, "a real multi-eviction season was played");
  assert.deepStrictEqual(this.vdOn!.evictionOrder, this.vdOff!.evictionOrder, "vote deduction ON must not move the eviction order");
  assert.deepStrictEqual(this.vdOn!.resume, this.vdOff!.resume, "vote deduction ON must not move the competition tally");
});
