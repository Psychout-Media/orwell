import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, refuteClaim, type BeliefStore, type BeliefClaim } from "../../src/engine/beliefStore";
import { BELIEF_PULL, beliefPull, believedGrievances, grievanceOf } from "../../src/engine/beliefDecisions";

/** Feature 0169 - gossip feeds beliefs. Drives the REAL adapter's belief receipt observer. TEST-ONLY seam: the live season and the relationship model. Roles only. */
type Seam = { live: { playedGame?: boolean; beliefs?: BeliefStore; week: number }; rel: { edge(a: string, b: string): { trust: number } } };
type Bag = { s?: GameSessionAdapter; ids: string[]; flagOn?: boolean };
const bag = (w: unknown): Bag => ((w as { g0169?: Bag }).g0169 ??= { ids: [] });
const seam = (s: GameSessionAdapter) => s as unknown as Seam;
let n = 0;

function played(w: unknown, flagOn: boolean): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`gossip0169-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.setGossipBeliefsEnabled(flagOn);
  sb.session.createCharacter({ playerName: "The Player", seed: 12 });
  seam(sb.session).live.playedGame = true;
  const b = bag(w);
  b.s = sb.session; b.flagOn = flagOn;
  b.ids = sb.session.livingIds().filter((id) => id !== PLAYER);
  return sb.session;
}
const hear = (s: GameSessionAdapter, listener: string, teller: string, subject: string, type = "betrayal", unfolded = true) =>
  s.beliefReceiptObserver()!({ listener, subject, type, confidence: 0.9, delta: {}, source: teller, factId: `f:${listener}:${subject}`, unfolded });
const rumorOf = (s: GameSessionAdapter, holder: string, subject: string): BeliefClaim =>
  claimsOf(seam(s).live.beliefs, holder).find((c) => c.kind === "heard-rumor" && c.subject === subject)!;

Given("a played season with a houseguest who trusts the teller and one who does not", function () {
  const s = played(this, true);
  const [a, b, t] = bag(this).ids as [string, string, string];
  seam(s).rel.edge(a, t).trust = 0.95;
  seam(s).rel.edge(b, t).trust = 0.05;
});
When("each hears the same betrayal rumor from the teller", function () {
  const s = bag(this).s!;
  const [a, b, t, sub] = bag(this).ids as [string, string, string, string];
  hear(s, a, t, sub); hear(s, b, t, sub);
});
Then("each holds the rumor with the teller as its source", function () {
  const s = bag(this).s!;
  const [a, b, t, sub] = bag(this).ids as [string, string, string, string];
  assert.equal(rumorOf(s, a, sub).source, t); assert.equal(rumorOf(s, b, sub).source, t);
});
Then("the one who trusts the teller holds it with more conviction", function () {
  const s = bag(this).s!;
  const [a, b, , sub] = bag(this).ids as [string, string, string, string];
  assert.ok(rumorOf(s, a, sub).confidence > rumorOf(s, b, sub).confidence);
});

const firm = (holder: string, subject: string, nature: string): BeliefClaim =>
  ({ id: `${holder}|heard-rumor|${subject}|${nature}`, holder, kind: "heard-rumor", subject, value: true, origin: "gossip", nature, source: "teller", confidence: 1, week: 1 });
Given("a listener who holds a firm betrayal rumor about a subject", function () {
  const b = bag(this);
  b.ids = ["listener", "subject"];
  (this as { store?: BeliefStore }).store = { listener: [firm("listener", "subject", "betrayal")] };
});
Then("the rumor counts against the subject in the listener's choices", function () {
  assert.ok(beliefPull((this as { store?: BeliefStore }).store, "listener", "subject", 1) > 0);
});
Then("it is too soft to start a revenge goal on its own", function () {
  assert.ok(BELIEF_PULL.kindWeight["rumored-threat"] < BELIEF_PULL.revengeBar);
  assert.deepEqual(believedGrievances((this as { store?: BeliefStore }).store, "listener", ["subject"], 1), []);
});
Then("an alliance rumor counts for nothing", function () {
  assert.equal(grievanceOf(firm("listener", "subject", "alliance"), "listener"), undefined);
});

Given("a played season with a listener who trusts the teller", function () {
  const s = played(this, true);
  const [l, t] = bag(this).ids as [string, string];
  seam(s).rel.edge(l, t).trust = 0.95;
});
When("the listener hears a betrayal rumor in a scene", function () {
  const s = bag(this).s!;
  const [l, t, sub] = bag(this).ids as [string, string, string];
  (this as { before?: number }).before = seam(s).rel.edge(l, sub).trust;
  hear(s, l, t, sub);
});
Then("the listener's trust in the subject falls a little", function () {
  const s = bag(this).s!;
  const [l, , sub] = bag(this).ids as [string, string, string];
  assert.ok(seam(s).rel.edge(l, sub).trust < (this as { before?: number }).before!);
});
Then("a refuted rumor takes half of that back", function () {
  const s = bag(this).s!;
  const [l, , sub] = bag(this).ids as [string, string, string];
  const c = rumorOf(s, l, sub);
  const low = seam(s).rel.edge(l, sub).trust;
  refuteClaim(seam(s).live.beliefs!, l, c.id, (h, o) => seam(s).rel.edge(h, o) as never);
  assert.ok(seam(s).rel.edge(l, sub).trust > low);
});

Given("a played season with the gossip-beliefs flag off", function () { played(this, false); });
When("a listener hears a betrayal rumor from a teller", function () {
  const s = bag(this).s!;
  const [l, t, sub] = bag(this).ids as [string, string, string];
  (this as { before?: number }).before = seam(s).rel.edge(l, sub).trust;
  hear(s, l, t, sub);
});
Then("the rumor has no source and counts in no choice", function () {
  const s = bag(this).s!;
  const [l, , sub] = bag(this).ids as [string, string, string];
  const c = rumorOf(s, l, sub);
  assert.equal(c.source, undefined);
  assert.equal(grievanceOf(c, l), undefined);
});
Then("no feelings moved beyond what the telling already did", function () {
  const s = bag(this).s!;
  const [l, , sub] = bag(this).ids as [string, string, string];
  assert.equal(seam(s).rel.edge(l, sub).trust, (this as { before?: number }).before);
});
