import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { exposureHits, reopened, type ExposureHit, type LedgerDeal } from "../../src/engine/dealExposure";
import type { BeliefClaim, BeliefStore } from "../../src/engine/beliefStore";

/** Feature 0186 - drives the pure exposure and reopening rules directly. Roles only. */
type Bag = { dealer: string; beliefs: BeliefStore; hits: ExposureHit[]; seen: Set<string>; houseNpcs: string[]; ledger: LedgerDeal[] };
const bag = (w: unknown): Bag => ((w as { ex0186?: Bag }).ex0186 ??= { dealer: "dealer", beliefs: {}, hits: [], seen: new Set(), houseNpcs: ["dealer", "p1", "p2", "b1", "b2"], ledger: [] });
const claim = (holder: string, subject: string, object: string): BeliefClaim =>
  ({ id: `${holder}|allied-with|${subject}|${object}|1`, holder, kind: "allied-with", subject, object, value: true, origin: "told", confidence: 0.8, week: 1 });
const deals = (b: Bag): LedgerDeal[] => [
  { id: "d1", parties: [b.dealer, "p1"], kind: "final-two", status: "open" },
  { id: "d2", parties: [b.dealer, "p2"], kind: "final-two", status: "open" },
];
const run = (b: Bag): ExposureHit[] => exposureHits({ deals: deals(b), beliefs: b.beliefs, living: [...b.houseNpcs, "player"], npcs: b.houseNpcs.filter((x) => x !== b.dealer), seen: b.seen });

Given("a double-dealer who holds a final two with partner one and partner two", function () { bag(this); });
Given("partner one holds that the double-dealer is allied with partner two", function () { const b = bag(this); b.beliefs.p1 = [claim("p1", b.dealer, "p2")]; });
Given("exposed: most of the house holds that the double-dealer is allied with partner two", function () { const b = bag(this); for (const h of ["b1", "b2", "p1"]) b.beliefs[h] = [claim(h, b.dealer, "p2")]; delete b.beliefs.p1; });
Given("exposed: the double-dealer is a houseguest and not the player", function () { const b = bag(this); assert.notEqual(b.dealer, "player"); });
Given("exposed: the double-dealer is the player", function () { const b = bag(this); b.beliefs = { p1: [claim("p1", "player", "p2")] }; b.dealer = "player"; b.houseNpcs = ["p1", "p2", "b1", "b2"]; });
When("exposed: the night passes", function () { const b = bag(this); b.hits = run(b); for (const h of b.hits) b.seen.add(h.key); });
Then("exposed: partner one is hit and partner two is not", function () { const b = bag(this); assert.ok(b.hits.some((h) => h.holder === "p1" && h.doubleDealer === b.dealer)); assert.ok(!b.hits.some((h) => h.holder === "p2")); });
Then("exposed: nobody is hit", function () { assert.deepEqual(bag(this).hits, []); });
Then("exposed: a repeat night hits no one twice", function () { assert.deepEqual(run(bag(this)), []); });
Given("exposed: three open deals among four houseguests", function () { bag(this).ledger = [
  { id: "x1", parties: ["a", "b"], kind: "final-two", status: "open" }, { id: "x2", parties: ["a", "c"], kind: "safety", status: "open" }, { id: "x3", parties: ["c", "d"], kind: "vote", status: "open" }]; });
Then("exposed: a win by one party reopens only the deals it is party to", function () { const ids = reopened(bag(this).ledger, { kind: "hoh", hoh: "a" }, new Set(["a", "b", "c", "d"])).map((d) => d.id); assert.deepEqual(ids, ["x1", "x2"]); });
Then("exposed: a double eviction reopens every open deal", function () { assert.equal(reopened(bag(this).ledger, { kind: "double-eviction" }, new Set(["a", "b", "c", "d"])).length, 3); });
Then("exposed: two runs give identical hits", function () { const b = bag(this); assert.deepEqual(run(b), run(b)); });
Then("exposed: the hit carries no number the player could read", function () { const b = bag(this); assert.ok(run(b).every((h) => Object.values(h).every((v) => typeof v === "string"))); });
