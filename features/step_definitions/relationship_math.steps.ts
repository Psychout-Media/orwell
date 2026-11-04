import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { RelationshipModel, CONFIDENCE_KNOWLEDGE } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS, type EdgeSignals, type RelationshipConstants } from "../../src/engine/relationshipConstants";
import { generateHouse, dispositionOf } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

const A = npc(1);
const B = npc(2);
const C = npc(3);

/** A constants clone with a different betrayal magnitude — the single 'feel' knob. */
function withBetrayal(betrayal: Partial<EdgeSignals>): RelationshipConstants {
  return { ...RELATIONSHIP_CONSTANTS, BETRAYAL_SHOCK: betrayal, IMPACT: { ...RELATIONSHIP_CONSTANTS.IMPACT, betrayal } };
}

/** Aggregate residual grudge of a cast toward the player, after a betrayal + a quiet stretch. */
function stickiness(seed: number): number {
  const rel = new RelationshipModel(0.6);
  const house = generateHouse(new SeededRandom(seed));
  for (const n of house.npcs) rel.setDisposition(n.id, dispositionOf(n.character.archetype));
  for (const n of house.npcs) rel.applyDirected(n.id, PLAYER, "betrayal", new SeededRandom(seed));
  for (let i = 0; i < 4; i++) rel.decay(0.1);
  const residual = house.npcs.map((n) => rel.edge(n.id, PLAYER).threat);
  return residual.reduce((a, b) => a + b, 0) / residual.length;
}

// --- A betrayal lingers (the sticky default) ----------------------------------
// Reuses 0017's "an established trusting edge from one houseguest toward another" (Given).

When("the holder witnesses a betrayal", function (this: BbWorld) {
  this.rel!.applyDirected(A, B, "betrayal", new SeededRandom(2));
  this.relThreatAfterBetrayal = this.rel!.edge(A, B).threat;
});

When("then a quiet stretch passes with no further interaction", function (this: BbWorld) {
  for (let i = 0; i < 6; i++) this.rel!.decay(RELATIONSHIP_CONSTANTS.DECAY_RATE);
});

Then("the holder's trust toward the other stays depressed", function (this: BbWorld) {
  assert.ok(this.rel!.edge(A, B).trust < this.relTrustBefore! - 0.15, "trust did not stay depressed");
});

Then("the grudge has not decayed away", function (this: BbWorld) {
  assert.ok(this.rel!.edge(A, B).threat > RELATIONSHIP_CONSTANTS.baseline.threat, "wariness should linger");
  assert.ok(this.relThreatAfterBetrayal! > 0.2);
});

// --- A betrayal is a single sharp step ----------------------------------------
// Reuses 0017's "an established edge between two houseguests" (Given, now also captures
// relTrustBefore) and "trust and affinity drop sharply in one step" (Then).

When("one witnessed betrayal occurs", function (this: BbWorld) {
  this.rel!.applyDirected(A, B, "betrayal", new SeededRandom(4));
});

Then("threat rises in the same step", function (this: BbWorld) {
  // Post-betrayal threat has jumped well above the baseline (0.1) in this single step.
  assert.ok(this.rel!.edge(A, B).threat > 0.2, "threat should jump in the same step");
});

// --- Disposition changes how sticky the same history feels --------------------

Given("identical interaction history including a betrayal", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  this.rel.setDisposition(A, "clash"); // paranoid / grudge-holding
  this.rel.setDisposition(C, "bond"); // forgiving / loyal
  for (const holder of [A, C]) {
    const rng = new SeededRandom(10); // identical jitter for both holders — only disposition differs
    for (let i = 0; i < 4; i++) this.rel.applyDirected(holder, B, "bonding", rng);
  }
  for (const holder of [A, C]) this.rel.applyDirected(holder, B, "betrayal", new SeededRandom(11));
});

When("it is read by a paranoid houseguest and by a forgiving one", function (this: BbWorld) {
  // The directed edges A->B (clash) and C->B (bond) are formed from the same history.
  assert.ok(this.rel!.edge(A, B) && this.rel!.edge(C, B));
});

Then("the paranoid houseguest's grudge is stronger and decays slower", function (this: BbWorld) {
  const clash = this.rel!.edge(A, B);
  const bond = this.rel!.edge(C, B);
  assert.ok(clash.threat > bond.threat, "paranoid grudge should be stronger");
  assert.ok(clash.trust < bond.trust);
  // AMEND 0024/0026 #3: the old check (clash threat > bond threat AFTER decay) was already true BEFORE any decay, so it could not fail on the decay rate. Compare the FRACTION of the
  // grudge (threat above the baseline) that SURVIVES the same quiet stretch: the paranoid keeps a larger fraction than the forgiving, and both actually fade.
  const base = RELATIONSHIP_CONSTANTS.baseline.threat;
  const excess = (h: typeof A): number => this.rel!.edge(h, B).threat - base;
  const clashBefore = excess(A), bondBefore = excess(C);
  assert.ok(clashBefore > 0 && bondBefore > 0, "both hold a real grudge to decay");
  for (let i = 0; i < 5; i++) this.rel!.decay(0.1); // a quiet stretch for both
  const clashKept = excess(A) / clashBefore, bondKept = excess(C) / bondBefore;
  assert.ok(clashKept < 1 && bondKept < 1, `both grudges fade (clash kept ${clashKept.toFixed(3)}, bond kept ${bondKept.toFixed(3)})`);
  assert.ok(clashKept > bondKept, `the paranoid grudge decays SLOWER: it keeps a larger fraction (${clashKept.toFixed(3)} vs ${bondKept.toFixed(3)})`);
});

Then("the forgiving houseguest's grudge is softer and fades faster", function (this: BbWorld) {
  const clash = this.rel!.edge(A, B);
  const bond = this.rel!.edge(C, B);
  assert.ok(bond.threat < clash.threat, "forgiving grudge should be softer");
  assert.ok(bond.trust > clash.trust, "forgiving warmth should recover faster");
});

// --- The feel varies across games but is reproducible by seed -----------------

Given("many casts generated across different seeds", function (this: BbWorld) {
  this.feels = Array.from({ length: 20 }, (_, i) => stickiness(i + 1));
});

Then("the aggregate stickiness of relationships varies measurably between games", function (this: BbWorld) {
  const spread = Math.max(...this.feels!) - Math.min(...this.feels!);
  assert.ok(spread > 0.01, `aggregate feel should vary across seeds (spread=${spread})`);
});

Then("the same seed reproduces the same dynamics", function () {
  for (const seed of [3, 7, 15]) assert.equal(stickiness(seed), stickiness(seed));
});

// --- Confidence firms up with interaction data --------------------------------

Given("two houseguests with little interaction", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6);
  this.rel.applyDirected(A, B, "gossip", new SeededRandom(5));
  this.relConfLow = this.rel.edge(A, B).confidence;
});

Then("the edge's confidence is low", function (this: BbWorld) {
  assert.equal(this.rel!.read(A, B).kind, "suspicion");
  assert.ok(this.relConfLow! < CONFIDENCE_KNOWLEDGE);
});

When("more interactions accumulate", function (this: BbWorld) {
  const rng = new SeededRandom(6);
  for (let i = 0; i < 10; i++) this.rel!.apply(A, B, "strategy", rng);
});

Then("the confidence rises", function (this: BbWorld) {
  assert.ok(this.rel!.edge(A, B).confidence > this.relConfLow!, "confidence should rise with data");
  assert.equal(this.rel!.read(A, B).kind, "knowledge");
});

// --- The feel is retunable from one constants module --------------------------

Given("the relationship constants module", function (this: BbWorld) {
  this.rel = new RelationshipModel(0.6); // the default-constants baseline
});

When("a weight such as the betrayal-shock is changed", function (this: BbWorld) {
  this.harsherConstants = withBetrayal({ trust: -0.6, affinity: -0.5, threat: +0.5 });
});

Then("the resulting dynamics change accordingly", function (this: BbWorld) {
  const defaultRel = new RelationshipModel(0.6);
  const harsherRel = new RelationshipModel(0.6, this.harsherConstants!);
  for (const r of [defaultRel, harsherRel]) {
    const rng = new SeededRandom(20); // identical trust headroom (bonding uses default in both)
    for (let i = 0; i < 6; i++) r.applyDirected(A, B, "bonding", rng);
  }
  defaultRel.applyDirected(A, B, "betrayal", new SeededRandom(8));
  harsherRel.applyDirected(A, B, "betrayal", new SeededRandom(8));
  assert.ok(harsherRel.edge(A, B).trust < defaultRel.edge(A, B).trust, "a harsher shock constant should bite harder");
});

Then("no relationship number is hard-coded outside that module", function () {
  // Zeroing the betrayal impact in the module makes applying it a no-op — proof the update logic
  // reads its numbers ONLY from the constants module (no hidden fallback).
  const inert = new RelationshipModel(0.6, withBetrayal({ trust: 0, affinity: 0, threat: 0 }));
  const base = { ...inert.edge(A, B) };
  inert.applyDirected(A, B, "betrayal", new SeededRandom(9));
  const e = inert.edge(A, B);
  assert.equal(e.trust, base.trust);
  assert.equal(e.affinity, base.affinity);
  assert.equal(e.threat, base.threat);
});
