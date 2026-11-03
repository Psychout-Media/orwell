import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  RelationshipModel, relationshipLabel, NEUTRAL_BOND, CONFIDENCE_KNOWLEDGE,
} from "../../src/engine/relationships";
import { generateHouse } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";

const A = npc(1);
const B = npc(2);

// --- Graded, not binary -------------------------------------------------------

Given("a directed relationship from one houseguest toward another", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  this.rel.edge(A, B); // lazily created at neutral
});

Then("the edge exposes graded signals including trust, affinity, and threat", function (this: BbWorld) {
  const e = this.rel!.edge(A, B) as unknown as Record<string, unknown>;
  for (const k of ["trust", "affinity", "threat"]) assert.equal(typeof e[k], "number");
});

Then("the edge is not a binary ally-or-enemy flag", function (this: BbWorld) {
  const e = this.rel!.edge(A, B);
  assert.notEqual(typeof e, "boolean");
  assert.ok(!("ally" in e) && !("enemy" in e));
});

// --- Directed / asymmetric ----------------------------------------------------

Given("a history where one houseguest invests in another who does not reciprocate", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  const rng = new SeededRandom(1);
  for (let i = 0; i < 6; i++) this.rel.applyDirected(A, B, "bonding", rng); // only A → B
});

Then("the edge in one direction differs from the edge in the other direction", function (this: BbWorld) {
  assert.ok(this.rel!.bondStrength(A, B) > this.rel!.bondStrength(B, A) + 0.1, "A→B invested, B→A did not");
});

// --- Uncertain, then firms up -------------------------------------------------

Given("two houseguests who have barely interacted", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  this.rel.applyDirected(A, B, "gossip", new SeededRandom(1)); // a single light touch
});

Then("the relationship read has low confidence", function (this: BbWorld) {
  const r = this.rel!.read(A, B);
  this.relConfBefore = r.confidence;
  assert.ok(r.confidence < CONFIDENCE_KNOWLEDGE);
});

Then("it is a suspicion rather than knowledge", function (this: BbWorld) {
  assert.equal(this.rel!.read(A, B).kind, "suspicion");
});

When("consistent interactions accumulate between them", function (this: BbWorld) {
  const rng = new SeededRandom(2);
  for (let i = 0; i < 10; i++) this.rel!.apply(A, B, "strategy", rng);
});

Then("the relationship read's confidence rises", function (this: BbWorld) {
  const r = this.rel!.read(A, B);
  assert.ok(r.confidence > this.relConfBefore!);
  assert.equal(r.kind, "knowledge");
});

// --- Betrayal shock -----------------------------------------------------------

Given("an established trusting edge from one houseguest toward another", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  const rng = new SeededRandom(3);
  for (let i = 0; i < 6; i++) this.rel.apply(A, B, "bonding", rng);
  this.relTrustBefore = this.rel.edge(A, B).trust;
});

When("the holder witnesses the other betray them", function (this: BbWorld) {
  this.rel!.applyDirected(A, B, "betrayal", new SeededRandom(4));
});

Then("trust and affinity drop sharply in one step", function (this: BbWorld) {
  assert.ok(this.rel!.edge(A, B).trust < this.relTrustBefore! - 0.2, "trust drops sharply");
});

Then("threat rises", function (this: BbWorld) {
  assert.ok(this.rel!.edge(A, B).threat > 0.1, "threat rises above baseline");
});

// --- Decay toward baseline ----------------------------------------------------

Given("an established edge between two houseguests", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  const rng = new SeededRandom(5);
  for (let i = 0; i < 6; i++) this.rel.apply(A, B, "bonding", rng);
  this.relBondBefore = this.rel.bondStrength(A, B);
  this.relTrustBefore = this.rel.edge(A, B).trust; // shared with 0026's sharp-step scenario
});

When("they do not interact for a long stretch", function (this: BbWorld) {
  for (let i = 0; i < 12; i++) this.rel!.decay(0.2);
});

Then("the edge drifts back toward the holder's baseline", function (this: BbWorld) {
  const now = this.rel!.bondStrength(A, B);
  assert.ok(now < this.relBondBefore!, "bond weakened");
  assert.ok(Math.abs(now - NEUTRAL_BOND) < Math.abs(this.relBondBefore! - NEUTRAL_BOND), "drifted toward baseline");
});

// --- No stored label ----------------------------------------------------------

When("a houseguest's soul is serialized", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  const rng = new SeededRandom(6);
  for (let i = 0; i < 4; i++) this.rel.apply(A, B, "strategy", rng);
  const { npcs } = generateHouse(new SeededRandom(6));
  // The "soul" payload = the dynamic soul (with memory/history) + the computed edges.
  this.lastOutput = JSON.stringify({ soul: npcs[0]!.soul, relationships: this.rel.serialize() });
});

Then("it contains the graded signals and the interaction history", function (this: BbWorld) {
  assert.match(this.lastOutput, /"trust"/);
  assert.match(this.lastOutput, /"affinity"/);
  assert.match(this.lastOutput, /"threat"/);
  assert.match(this.lastOutput, /"memory"/); // the dynamic soul's accumulating history
});

Then("it contains no stored ally, enemy, or best-friend label", function (this: BbWorld) {
  assert.ok(!/"(ally|enemy|bestFriend|best_friend|label)"\s*:/i.test(this.lastOutput));
});

// --- Same history, different labels under different dispositions ---------------

Given("identical interaction history read by a paranoid houseguest and by a trusting one", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  this.rel.edge(A, B).trust = 0.5;
  this.rel.edge(A, B).affinity = 0.5;
  this.rel.edge(A, B).threat = 0.5;
});

When("each houseguest's view of the other is labeled", function (this: BbWorld) {
  const s = this.rel!.edge(A, B);
  this.labelParanoid = relationshipLabel(s, "clash");
  this.labelTrusting = relationshipLabel(s, "bond");
});

Then("the paranoid houseguest reads it as more of a threat", function (this: BbWorld) {
  assert.equal(this.labelParanoid, "enemy");
});

Then("the trusting houseguest reads it as more of a bond", function (this: BbWorld) {
  assert.equal(this.labelTrusting, "ally");
});

Then("each label is derived on the spot, not stored", function (this: BbWorld) {
  assert.notEqual(this.labelParanoid, this.labelTrusting); // same signals, different reads
  assert.ok(!("ally" in this.rel!.edge(A, B)) && !("enemy" in this.rel!.edge(A, B)));
});

// --- Houseguest's Choice reads the strongest available bond -------------------

Given("an NPC must pick a houseguest by their own motivation", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  const rng = new SeededRandom(7);
  for (let i = 0; i < 8; i++) this.rel.applyDirected(A, npc(3), "alliance", rng); // strongest bond → npc(3)
  for (let i = 0; i < 2; i++) this.rel.applyDirected(A, npc(4), "gossip", rng);
});

When("the NPC chooses", function () {
  // The assertion drives the seeded choices.
});

Then("the NPC picks their strongest available bond as scored by the signals", function (this: BbWorld) {
  const candidates = [npc(2), npc(3), npc(4)];
  for (let seed = 1; seed <= 20; seed++) {
    assert.equal(this.rel!.chooseStrongestBond(A, candidates, new SeededRandom(seed)), npc(3), `seed ${seed}`);
  }
});

Then("the choice carries bounded temperature variance", function (this: BbWorld) {
  // Variance is REAL: two near-equal bonds are each chosen under some seeds (the temperature genuinely wobbles a near-tie)...
  const r = new RelationshipModel(0.6);
  const rng = new SeededRandom(1);
  for (let i = 0; i < 3; i++) { r.applyDirected(A, npc(5), "bonding", rng); r.applyDirected(A, npc(6), "bonding", rng); }
  const TEMP = 0.4;
  const tieGap = Math.abs(r.bondStrength(A, npc(5)) - r.bondStrength(A, npc(6)));
  assert.ok(tieGap < TEMP / 2, `the fixture is a genuine near-tie (gap ${tieGap})`);
  const picks = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) picks.add(r.chooseStrongestBond(A, [npc(5), npc(6)], new SeededRandom(seed), TEMP));
  assert.equal(picks.size, 2, "a near-tie wobbles: both candidates win under some seeds");

  // ...and BOUNDED: the roll can swing a score by at most the temperature, so a bond that leads by more than that
  // is never flipped, however many seeds (here: the strongest bond vs an untouched houseguest).
  const clearGap = this.rel!.bondStrength(A, npc(3)) - this.rel!.bondStrength(A, npc(2));
  assert.ok(clearGap > 0.1, `the fixture has a clear lead (gap ${clearGap})`);
  const bounded = clearGap * 0.9;
  for (let seed = 1; seed <= 300; seed++) {
    assert.equal(this.rel!.chooseStrongestBond(A, [npc(2), npc(3)], new SeededRandom(seed), bounded), npc(3), `seed ${seed}: a clear bond was flipped`);
  }
});
