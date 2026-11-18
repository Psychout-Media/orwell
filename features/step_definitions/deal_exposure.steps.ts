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

/** 0186 amendment - the live adapter, a double eviction over an NPC pair, with a stored plan per promiser. Roles only. */
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
type TwistSeam = {
  live: { playedGame?: boolean; week: number; hoh?: string; pending?: unknown; twist?: unknown; dealPlans?: Record<string, Record<string, { kind: string; madeWeek: number }>> };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string; status: string; learned?: boolean; sealedBallot?: boolean; brokenBy?: string }; learnOfBreak(d: unknown, s: object): boolean };
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setDealDepthEnabled(on: boolean): void; setDealExposureEnabled(on: boolean): void; setDealPlansEnabled(on: boolean): void;
  reopenDealsOnTwist(): void; livingIds(): string[]; advanceView(x: null): unknown;
};
type TwistRun = { g: TwistSeam; a: string; b: string; deal: ReturnType<TwistSeam["deals"]["make"]>; before: number[]; after: number[]; broke: boolean };
const SEEDS = Array.from({ length: 150 }, (_, i) => 21 + i);
function twistRun(plans: boolean, kind: string, want: boolean | undefined): TwistRun {
  let last: TwistRun | undefined;
  for (const seed of SEEDS) {
    const sb = new GameSessionRegistry().sandboxFor(`twistbreak-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as TwistSeam;
    g.setDealDepthEnabled(true); g.setDealExposureEnabled(true); g.setDealPlansEnabled(plans);
    g.live.playedGame = true; g.live.pending = undefined;
    const npcs = g.livingIds().filter((i) => i !== PLAYER);
    const [a, b] = npcs as [string, string];
    for (const [x, y] of [[a, b], [b, a]] as const) { const e = g.rel.edge(x, y); e.trust = -0.5; e.affinity = -0.5; e.threat = 1; }
    g.live.hoh ??= npcs[2]!; g.live.twist = { kind: "double-eviction", phase: "pending" };
    const deal = g.deals.make([a, b], "final-two", "t", undefined, g.live.week);
    g.live.dealPlans = { [deal.id]: { [a]: { kind, madeWeek: g.live.week }, [b]: { kind, madeWeek: g.live.week } } };
    const before = [g.rel.edge(a, b).trust, g.rel.edge(b, a).trust];
    g.reopenDealsOnTwist();
    last = { g, a, b, deal, before, after: [g.rel.edge(a, b).trust, g.rel.edge(b, a).trust], broke: deal.status === "broken" };
    if (want === undefined || last.broke === want) return last;
  }
  return last!;
}
const tw = (w: unknown): { run?: TwistRun; faking?: boolean } => ((w as { tw0186?: { run?: TwistRun; faking?: boolean } }).tw0186 ??= {});
Given("twistbreak: a final two between two houseguests after a double eviction", function () { tw(this); });
When("twistbreak: the promiser held a faking plan", function () { const t = tw(this); t.faking = true; t.run = twistRun(true, "break-at", true); });
When("twistbreak: the promiser held an honest plan", function () { tw(this).run = twistRun(true, "keep", undefined); });
When("twistbreak: the plan model is off and the promiser held a faking plan", function () { tw(this).run = twistRun(false, "break-at", undefined); });
Then("twistbreak: the deal is quietly broken, not yet learned, and still reads open to the partner", function () {
  const r = tw(this).run!; assert.equal(r.deal.status, "broken"); assert.equal(r.deal.learned, false); assert.equal(r.deal.sealedBallot, true); assert.ok(r.deal.brokenBy);
});
Then("twistbreak: nobody is betrayed and no trust moves", function () { const r = tw(this).run!; assert.notEqual(r.deal.status, "broken"); assert.equal(r.deal.brokenBy, undefined); assert.deepEqual(r.after, r.before); });
Then("twistbreak: the partner's read of the promiser moves only once the break is learned", function () {
  const r = tw(this).run!; const breaker = r.deal.brokenBy!; const wronged = breaker === r.a ? r.b : r.a;
  const was = JSON.stringify(r.g.rel.edge(wronged, breaker));
  assert.equal(r.g.rel.edge(wronged, breaker).trust, r.before[wronged === r.a ? 0 : 1]);
  assert.equal(r.g.deals.learnOfBreak(r.deal, { rel: r.g.rel, rng: new SeededRandom(1) }), true);
  assert.notEqual(JSON.stringify(r.g.rel.edge(wronged, breaker)), was);
});
Then("twistbreak: no outward view carries the plan", function () {
  const out = JSON.stringify(tw(this).run!.g.advanceView(null)); assert.ok(!out.includes("break-at") && !out.includes("dealPlans") && !out.includes("deal-twist-betray"));
});
