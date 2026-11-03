import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { DealLedger } from "../../src/engine/deals";
import type { ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0121 (PO expansion of the 0039 review), Part 1 — the ACTIVE-obligation deal kinds. Roles only.
const PROMISOR = npc(1);
const PROTECT = npc(2);
const OTHER = npc(3);
const FOURTH = npc(4);

function sinkFor(w: BbWorld): ReconcileSink {
  w.dealDepthRel = new RelationshipModel(0.5);
  w.dealDepthDemerits = [];
  return {
    rel: w.dealDepthRel,
    rng: new SeededRandom(7),
    juryDemerit: (wronged, breaker) => w.dealDepthDemerits!.push({ wronged, breaker }),
    reveal: () => "evt:reveal",
  };
}

// --- comp-throw ----------------------------------------------------------------

Given("a comp-throw promise to throw a competition", function (this: BbWorld) {
  this.dealDepthLedger = new DealLedger();
  this.dealDepthDeal = this.dealDepthLedger.make([PROMISOR, PROTECT], "comp-throw", "I'll throw the HOH so you win");
});

When("the promisor throws that competition", function (this: BbWorld) {
  this.dealDepthLedger!.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "threw" }, sinkFor(this));
});

Then("the promise is kept", function (this: BbWorld) {
  assert.equal(this.dealDepthDeal!.status, "kept");
});

When("another promisor wins the competition they swore to throw", function (this: BbWorld) {
  this.dealDepthLedgerB = new DealLedger();
  this.dealDepthDealB = this.dealDepthLedgerB.make([PROMISOR, PROTECT], "comp-throw", "throw it");
  this.dealDepthTrustBefore = 0.25; // fresh relationship baseline trust of the wronged→breaker read
  const sink = sinkFor(this);
  this.dealDepthTrustBefore = this.dealDepthRel!.edge(PROTECT, PROMISOR).trust;
  this.dealDepthLedgerB.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "won" }, sink);
});

Then("that promise is broken and the wronged party holds the grudge", function (this: BbWorld) {
  const d = this.dealDepthDealB ?? this.dealDepthDeal!;
  assert.equal(d.status, "broken");
  assert.ok(this.dealDepthRel!.edge(PROTECT, PROMISOR).trust < this.dealDepthTrustBefore!, "trust dropped on the breaker");
  assert.deepEqual(this.dealDepthDemerits, [{ wronged: PROTECT, breaker: PROMISOR }]);
});

// --- veto-save -----------------------------------------------------------------

Given("a veto-save promise to use the veto to save a houseguest", function (this: BbWorld) {
  this.dealDepthLedger = new DealLedger();
  this.dealDepthDeal = this.dealDepthLedger.make([PROMISOR, PROTECT], "veto-save", "I'll veto you down");
});

When("the veto-holder pulls the promised houseguest off the block", function (this: BbWorld) {
  this.dealDepthLedger!.reconcile(
    { actor: PROMISOR, kind: "veto-use", targets: [], saved: [PROTECT], nominees: [PROTECT, OTHER] },
    sinkFor(this),
  );
});

When("the veto-holder leaves the promised houseguest nominated", function (this: BbWorld) {
  this.dealDepthTrustBefore = 0.25;
  const sink = sinkFor(this);
  this.dealDepthTrustBefore = this.dealDepthRel!.edge(PROTECT, PROMISOR).trust;
  this.dealDepthLedger!.reconcile(
    { actor: PROMISOR, kind: "veto-use", targets: [], saved: [OTHER], nominees: [PROTECT, OTHER] },
    sink,
  );
});

When("the veto is used while the promised houseguest is not on the block", function (this: BbWorld) {
  this.dealDepthLedger!.reconcile(
    { actor: PROMISOR, kind: "veto-use", targets: [], saved: [OTHER], nominees: [OTHER, FOURTH] },
    sinkFor(this),
  );
});

Then("the promise is still open with nothing owed", function (this: BbWorld) {
  assert.equal(this.dealDepthDeal!.status, "open");
  assert.equal(this.dealDepthDemerits!.length, 0);
});

// --- engine-decided, never prose -----------------------------------------------

Given("two comp-throw promises with very different wording", function (this: BbWorld) {
  this.dealDepthLedger = new DealLedger();
  this.dealDepthDeal = this.dealDepthLedger.make([PROMISOR, PROTECT], "comp-throw", "throw");
  this.dealDepthLedgerB = new DealLedger();
  this.dealDepthDealB = this.dealDepthLedgerB.make([PROMISOR, PROTECT], "comp-throw", "a long, heartfelt, flowery pledge to tank the whole thing for you, friend");
});

When("both promisors win the competition they swore to throw", function (this: BbWorld) {
  this.dealDepthLedger!.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "won" }, sinkFor(this));
  this.dealDepthLedgerB!.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "won" }, sinkFor(this));
});

Then("both promises break identically", function (this: BbWorld) {
  assert.equal(this.dealDepthDeal!.status, "broken");
  assert.equal(this.dealDepthDealB!.status, this.dealDepthDeal!.status);
});

// --- the flag gate -------------------------------------------------------------

Given("a live game with the deal-depth layer off", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("dd-off");
  sb.session.createCharacter({ playerName: "Player", seed: 7 });
  sb.session.setDealDepthEnabled(false);
  for (let i = 0; i < 80 && sb.session.snapshot().live?.hoh === undefined; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    }
    if (v.finished) break;
  }
  this.dealDepthSandbox = sb;
});

When("the player tries to make a comp-throw promise", function (this: BbWorld) {
  const npcId = this.dealDepthSandbox!.session.livingIds().find((id) => id !== PLAYER)!;
  const result = this.dealDepthSandbox!.session.makeDeal({ with: npcId, kind: "comp-throw", terms: "throw it for me" });
  this.dealDepthRefused = result === null;
});

Then("the promise is refused", function (this: BbWorld) {
  assert.equal(this.dealDepthRefused, true, "an active-obligation deal is refused when the deal-depth layer is off");
});
