import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { DealLedger } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { BindingAction } from "../../src/engine/deals";
import { resolvePending } from "../support/answerPending";
import type { DealView } from "../../src/ports/GameSession";

// HARD rule: roles only — promisor, partner, the wronged party. No names; all fixtures synthesized.
const PROMISOR = "promisor";
const PARTNER = "partner";

/** The seed shared across paired-deal scenarios so only the negotiated form differs. */
const SEED = 11;

/** The wronged party's hidden read of the breaker (the edge that takes the betrayal hit). */
function edge(rel: RelationshipModel) {
  return rel.edge(PARTNER, PROMISOR);
}

/** Break a deal by nominating the protected partner (the engine adjudicates the adverse swing). */
function breakIt(ledger: DealLedger, rel: RelationshipModel, currentWeek?: number) {
  ledger.reconcile(
    { actor: PROMISOR, kind: "nominate", targets: [PARTNER] },
    { rel, rng: new SeededRandom(SEED), ...(currentWeek !== undefined ? { currentWeek } : {}) },
  );
}

// --- Scenario: a no-duration break is byte-identical to 0039 ------------------

Given("a deal with no negotiated duration and no label", function (this: BbWorld) {
  this.ddLedger = new DealLedger();
  this.ddRel = new RelationshipModel(0.5);
  this.ddDeal = this.ddLedger.make([PROMISOR, PARTNER], "safety", "safe"); // no duration, no label
});

When("the promisor breaks it with no week context", function (this: BbWorld) {
  breakIt(this.ddLedger!, this.ddRel!); // currentWeek omitted ⇒ scale 1
  this.ddEdgeAfter = { ...edge(this.ddRel!) };
  // The pre-0109 reference fold: a bare applyDirected('betrayal') at the same seed.
  const ref = new RelationshipModel(0.5);
  ref.applyDirected(PARTNER, PROMISOR, "betrayal", new SeededRandom(SEED));
  this.ddEdgeRef = { ...ref.edge(PARTNER, PROMISOR) };
});

Then("the betrayal-shock folded is exactly the unscaled 0039 magnitude", function (this: BbWorld) {
  assert.deepEqual(this.ddEdgeAfter, this.ddEdgeRef, "no-duration break must fold byte-identically to 0039");
  assert.equal(this.ddDeal!.status, "broken");
});

// --- Scenarios 2-5 run the LIVE path (#1993): the term is PROPOSED via the session's `makeDeal`, bounded by
// the engine, and acted on by the live break / week-rollover seams. Roles only.

function liveGame(seed = 7): { s: GameSessionAdapter; npc: string } {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  s.setNpcDealConsentEnabled(false); // these scenarios exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  return { s, npc: s.getGameState().house[0]!.id };
}
const weekOf = (s: GameSessionAdapter) => s.snapshot().live!.week;
/** The promisor (the player) nominates the protected partner — the real adjudication path. */
function liveBreak(s: GameSessionAdapter, partner: string): void {
  (s as unknown as { reconcileDeals(a: BindingAction): void }).reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [partner] });
}
function liveThreat(s: GameSessionAdapter, npc: string): number {
  return (s as unknown as { rel: RelationshipModel }).rel.edge(npc, PLAYER).threat;
}
function liveTrust(s: GameSessionAdapter, npc: string): number {
  return (s as unknown as { rel: RelationshipModel }).rel.edge(npc, PLAYER).trust;
}
interface LiveDd { a: ReturnType<typeof liveGame>; b: ReturnType<typeof liveGame>; t0a: number; t0b: number; trust0a: number }
const live = new WeakMap<BbWorld, LiveDd>();
const dealIds = new WeakMap<BbWorld, { id: string; openId?: string }>();

// --- Scenario: explicit expiry is fair game once the term has passed ----------

Given("a season-horizon deal with an explicit two-week term", function (this: BbWorld) {
  const a = liveGame();
  const d = a.s.makeDeal({ with: a.npc, kind: "final-two", terms: "two weeks, then free", term: { weeks: 2 } }) as DealView;
  const open = a.s.makeDeal({ with: a.npc, kind: "final-two", terms: "forever" }) as DealView;
  live.set(this, { a, b: a, t0a: 0, t0b: 0, trust0a: 0 });
  dealIds.set(this, { id: d.id, openId: open.id });
  assert.equal(d.term?.expiresWeek, weekOf(a.s) + 1, "the engine recorded the two-week term from the live makeDeal");
});

When("the negotiated term passes without a break", function (this: BbWorld) {
  const { a } = live.get(this)!;
  const start = weekOf(a.s);
  for (let i = 0; i < 600 && weekOf(a.s) <= start + 1; i++) {
    const v = a.s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => a.s.submitDecision(req));
    if (v.finished) break;
  }
  assert.ok(weekOf(a.s) > start + 1, "the season rolled past the negotiated term");
});

Then("the engine resolves the deal kept", function (this: BbWorld) {
  const { a } = live.get(this)!;
  const ids = dealIds.get(this)!;
  const by = (id: string) => a.s.getGameState().deals!.find((x) => x.id === id)!;
  assert.equal(by(ids.id).status, "kept");
  assert.equal(by(ids.openId!).status, "open", "a termless season deal is untouched");
});

// --- Scenario: breaking early scales the shock up with life remaining ---------

Given("two identical deals with an explicit term, broken at the same seed", function (this: BbWorld) {
  const a = liveGame(); const b = liveGame();
  a.s.makeDeal({ with: a.npc, kind: "final-two", terms: "long way to go", term: { weeks: 8 } });
  b.s.makeDeal({ with: b.npc, kind: "final-two", terms: "almost done", term: { weeks: 1 } });
  live.set(this, { a, b, t0a: liveThreat(a.s, a.npc), t0b: liveThreat(b.s, b.npc), trust0a: 0 });
});

When("one is broken with many weeks of term left and the other with one week left", function (this: BbWorld) {
  const { a, b } = live.get(this)!;
  liveBreak(a.s, a.npc);
  liveBreak(b.s, b.npc);
});

Then("the many-weeks-left break raises the wronged party's threat more than the one-week-left break", function (this: BbWorld) {
  const { a, b, t0a, t0b } = live.get(this)!;
  const farRise = liveThreat(a.s, a.npc) - t0a;
  const nearRise = liveThreat(b.s, b.npc) - t0b;
  assert.ok(farRise > nearRise, "more remaining life ⇒ a larger threat rise");
  assert.ok(nearRise > 0, "a term-remaining break still hurts");
});

// --- Scenario: a vague promise softens the betrayal ---------------------------

Given("an open deal left vague and an equivalent deal with no duration", function (this: BbWorld) {
  const a = liveGame(); const b = liveGame();
  a.s.makeDeal({ with: a.npc, kind: "final-two", terms: "unspoken", term: { vague: true } });
  b.s.makeDeal({ with: b.npc, kind: "final-two", terms: "clean" });
  live.set(this, { a, b, t0a: liveThreat(a.s, a.npc), t0b: liveThreat(b.s, b.npc), trust0a: liveTrust(a.s, a.npc) });
});

When("each is broken at the same seed", function (this: BbWorld) {
  const { a, b } = live.get(this)!;
  liveBreak(a.s, a.npc); // vague ⇒ softened
  liveBreak(b.s, b.npc); // no duration ⇒ scale 1
});

Then("the vague break folds a smaller betrayal-shock than the no-duration break", function (this: BbWorld) {
  const { a, b, t0a, t0b } = live.get(this)!;
  assert.ok(liveThreat(a.s, a.npc) - t0a < liveThreat(b.s, b.npc) - t0b, "the vague break is softer than the unscaled break");
});

Then("the vague break is still a betrayal: threat rises and trust falls", function (this: BbWorld) {
  const { a, t0a, trust0a } = live.get(this)!;
  assert.ok(liveThreat(a.s, a.npc) - t0a > 0, "threat still rose");
  assert.ok(trust0a - liveTrust(a.s, a.npc) > 0, "trust still fell");
});

// --- Scenario: term persists; derived magnitude never reaches the player ------

Given("a deal with a negotiated term and the vague label", function (this: BbWorld) {
  const a = liveGame();
  a.s.makeDeal({ with: a.npc, kind: "final-two", terms: "two weeks", term: { weeks: 3 } });
  a.s.makeDeal({ with: a.npc, kind: "safety", terms: "unspoken", term: { vague: true } });
  live.set(this, { a, b: a, t0a: 0, t0b: 0, trust0a: 0 });
});

When("the deals are serialized and reloaded", function (this: BbWorld) {
  const d = live.get(this)!;
  const revived = new GameSessionAdapter();
  revived.restore(JSON.parse(JSON.stringify(d.a.s.snapshot())));
  d.b = { s: revived, npc: d.a.npc };
});

Then("both the term and the label survive the round-trip losslessly", function (this: BbWorld) {
  const { a, b } = live.get(this)!;
  assert.deepEqual(b.s.getGameState().deals, a.s.getGameState().deals, "the durable round-trip is lossless");
  const reloaded = b.s.getGameState().deals!;
  assert.equal(reloaded[0]!.term?.expiresWeek, weekOf(a.s) + 2, "the explicit term survived");
  assert.equal(reloaded[1]!.term?.vague, true, "the vague label survived");
});

Then("the player-facing deal shows the negotiated term but no shock or scale number", function (this: BbWorld) {
  const { a } = live.get(this)!;
  const deals = a.s.getGameState().deals!;
  const blob = JSON.stringify(deals);
  assert.ok(blob.includes("expiresWeek"), "the negotiated term is the player's own knowledge");
  for (const banned of ["trust", "threat", "affinity", "confidence", "reliability", "vagueSoften", "perWeekRemaining", "maxScale", "severity"]) {
    assert.ok(!blob.includes(banned), `player-facing deal must not expose ${banned}`);
  }
});
