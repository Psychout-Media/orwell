import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { nominationPlan, floaterRead, duoPartner } from "../../src/engine/season";
import { voteChoice } from "../../src/engine/liveSeason";
import type { SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { npc, PLAYER } from "../../src/domain/ids";
import type { NominationStyle } from "../../src/engine/decisionConstants";
import type { EntityId } from "../../src/domain/ids";

// Feature 0044 A-14 AMEND — live guards for floaterRead / duoRead+duoPartner / hohReferendumWeight.
// HARD rule: roles only. PRINCIPLE (kept in every step below): an NPC HOH decides from the NPC's OWN perspective, to
// benefit THAT NPC — never random, never what the player wants. Each scenario is built so a sign flip or a no-op
// style flips its outcome (verified by the mutation runs recorded in the PR).

interface Live {
  style?: NominationStyle;
  cast?: Record<string, EntityId>;
  rel: RelationshipModel;
  active: EntityId[];
  hoh: EntityId;
  nominees?: [EntityId, EntityId];
  target?: EntityId;
  votes?: { aligned: EntityId; opposed: EntityId };
}
const state = new WeakMap<BbWorld, Live>();

const HOH = npc(1);
const TARGET = npc(2);
const PROTECTED = npc(3);   // higher threat read than the floater, but well-connected
const ALLY = npc(4);        // the protected houseguest's friend
const FLOATER = npc(5);     // nobody holds a bond toward them
const PARTNER = npc(6);     // the target's tight-pair partner

function bond(rel: RelationshipModel, a: EntityId, b: EntityId, v: number): void {
  for (const [x, y] of [[a, b], [b, a]] as const) { const e = rel.edge(x, y); e.trust = v; e.affinity = v; }
}

// --- Scenario: a floater takes the pawn seat -------------------------------------------------

Given("an HOH whose style spends the second seat on whoever nobody will miss, facing a house with one floater", function (this: BbWorld) {
  // The HOH's own read: TARGET is the top threat; PROTECTED reads scarier than the FLOATER but is tightly bonded
  // to ALLY; nobody has any bond toward FLOATER. This HOH style ("protects their people; the pawn is whoever nobody will miss") benefits
  // itself by spending the second seat on the one nobody will fight for.
  const rel = new RelationshipModel(0.5);
  const active = [HOH, TARGET, PROTECTED, ALLY, FLOATER];
  rel.edge(HOH, TARGET).threat = 0.9;
  rel.edge(HOH, PROTECTED).threat = 0.5;
  rel.edge(HOH, ALLY).threat = 0.2;
  rel.edge(HOH, FLOATER).threat = 0.05;
  bond(rel, PROTECTED, ALLY, 0.9);
  bond(rel, TARGET, ALLY, 0.6);
  state.set(this, { rel, active, hoh: HOH, style: "loyalist" });
});

When("the HOH nominates", function (this: BbWorld) {
  const s = state.get(this)!;
  const plan = nominationPlan(s.hoh, s.active, s.rel, { style: s.style, disposition: "neutral" });
  s.nominees = plan.nominees;
  s.target = plan.target;
});

Then("the target is the top threat read", function (this: BbWorld) {
  assert.equal(state.get(this)!.target, TARGET, "the HOH puts up the houseguest THEY read as the top threat");
});

Then("the second seat goes to the floater, not to the better-protected houseguest with the higher threat read", function (this: BbWorld) {
  const s = state.get(this)!;
  assert.ok(floaterRead(FLOATER, s.active, s.rel) > floaterRead(PROTECTED, s.active, s.rel), "fixture: the floater really floats");
  assert.deepEqual([...s.nominees!].sort(), [TARGET, FLOATER].sort(), "the pawn seat is the one nobody will miss");
});

// --- Scenario: a duo-breaker puts the partner up --------------------------------------------

Given("a duo-breaking HOH whose top target is locked in a tight pair", function (this: BbWorld) {
  // TARGET and PARTNER share a mutual bond; the other candidates carry HIGHER raw threat reads than PARTNER, so only
  // the HOH's own "break up the pair" reading puts PARTNER beside TARGET (a power duo is a threat to THIS HOH).
  const rel = new RelationshipModel(0.5);
  const active = [HOH, TARGET, PARTNER, PROTECTED, ALLY];
  rel.edge(HOH, TARGET).threat = 0.7;
  rel.edge(HOH, PROTECTED).threat = 0.5;
  rel.edge(HOH, ALLY).threat = 0.45;
  rel.edge(HOH, PARTNER).threat = 0.1;
  bond(rel, TARGET, PARTNER, 0.95);
  assert.equal(duoPartner(TARGET, HOH, active, rel), PARTNER, "fixture: the target's partner is the tight pair");
  state.set(this, { rel, active, hoh: HOH, style: "duo-breaker" });
});

Then("the target and the target's duo partner are the two nominees", function (this: BbWorld) {
  const s = state.get(this)!;
  assert.equal(s.target, TARGET);
  assert.deepEqual([...s.nominees!].sort(), [TARGET, PARTNER].sort(), "one of the pair goes home unless the veto saves them");
});

// --- Scenario: the referendum on the HOH ----------------------------------------------------

Given("a house vote on an HOH's target and a pawn", function (this: BbWorld) {
  // The HOH reads NOMINEE_A as the bigger threat (their target). Both voters read the two nominees as EQUALLY
  // threatening, so the ONLY thing separating them is how they stand with the HOH.
  const rel = new RelationshipModel(0.5);
  const A = npc(7), B = npc(8), ALIGNED = npc(9), OPPOSED = npc(10);
  rel.edge(HOH, A).threat = 0.7;
  rel.edge(HOH, B).threat = 0.2;
  for (const v of [ALIGNED, OPPOSED]) { rel.edge(v, A).threat = 0.4; rel.edge(v, B).threat = 0.4; }
  bond(rel, ALIGNED, HOH, 0.95);                 // the HOH's friend: gives the HOH the target
  bond(rel, OPPOSED, HOH, 0.05);                 // not the HOH's friend...
  rel.edge(OPPOSED, HOH).threat = 0.9;           // ...and reads the HOH as a threat: keeps the target, sends the pawn
  state.set(this, { rel, active: [HOH, A, B, ALIGNED, OPPOSED], hoh: HOH, nominees: [A, B], target: A, votes: { aligned: ALIGNED, opposed: OPPOSED } });
});

const ctxFor = (rel: RelationshipModel): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
});

When("an aligned voter and an opposed voter each cast their eviction vote", function (this: BbWorld) {
  const s = state.get(this)!;
  const fn = s.nominees!;
  s.cast = {
    aligned: voteChoice(s.votes!.aligned, fn, ctxFor(s.rel), [], s.hoh),
    opposed: voteChoice(s.votes!.opposed, fn, ctxFor(s.rel), [], s.hoh),
  };
});

Then("the aligned voter sends the HOH's target home", function (this: BbWorld) {
  const s = state.get(this)!;
  assert.equal(s.cast!.aligned, s.target, "an aligned voter gives the HOH what the HOH wants");
});

Then("the opposed voter keeps the target and sends the pawn home", function (this: BbWorld) {
  const s = state.get(this)!;
  assert.equal(s.cast!.opposed, s.nominees![1], "an opposed voter denies the HOH their target");
});
