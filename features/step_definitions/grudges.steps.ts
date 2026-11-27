import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { REPAIR, easeGrudge, freshness, noteGrudge, repairAmount, type GrudgeBook } from "../../src/engine/grudges";
import { bondKey, foldBreak, foldRepair, type BondStore } from "../../src/engine/bondRecord";

/** Feature 0182 - drives the pure grudge book directly. Roles only. */
const book = (w: unknown): GrudgeBook => ((w as { gb0182?: GrudgeBook }).gb0182 ??= {});
const row = (w: unknown) => book(w)["holder|ally"]!;

Given("a houseguest who was cut by an ally in week 1", function () { noteGrudge(book(this), "holder", "ally", "cut-by-ally", 0.5, 1, 1, "a"); });
Then("the houseguest holds a grudge against that ally", function () { assert.ok(row(this)); });
Then("the grudge is sharper in week 2 than in week 40", function () { assert.ok(freshness(row(this), 2) > freshness(row(this), 40)); });
Then("the grudge in week 40 is still above zero", function () { assert.ok(freshness(row(this), 40) > 0); });
When("the wrong is eased again and again", function () {
  (this as { before0182?: number }).before0182 = freshness(row(this), 1);
  for (let i = 0; i < 50; i++) easeGrudge(row(this), 0.2);
});
Then("the grudge is fainter than before", function () { assert.ok(freshness(row(this), 1) < (this as { before0182?: number }).before0182!); });
Then("the grudge is still above zero", function () { assert.ok(freshness(row(this), 1) > 0); });
When("the same ally lies to them later and harder", function () { noteGrudge(book(this), "holder", "ally", "lied-to", 0.9, 3, 1, "b"); });
Then("the grudge remembers the lie", function () { assert.equal(row(this).kind, "lied-to"); });
Then("the strongest severity held is kept", function () { noteGrudge(book(this), "holder", "ally", "lied-to", 0.2, 4, 1, "c"); assert.equal(row(this).severity, 0.9); assert.equal(row(this).peak, 0.9); });

// PR 2: a rift can be partly repaired (the pure book beside the bond record).
type Rift = { store: BondStore; strain0: number; peak0: number; fresh0: number };
const rift = (w: unknown): Rift => (w as { rift0182?: Rift }).rift0182!;
Given("two houseguests who fell out", function () {
  const store: BondStore = {};
  foldBreak(store, "ally", "holder");
  noteGrudge(book(this), "holder", "ally", "deal-broken", 0.5, 1, 1, "d");
  const r = store[bondKey("holder", "ally")]!;
  (this as { rift0182?: Rift }).rift0182 = { store, strain0: r.strain, peak0: r.peakResentment, fresh0: freshness(row(this), 1) };
});
When("one keeps a promise to the other", function () {
  const eased = easeGrudge(row(this), repairAmount(REPAIR.kept));
  foldRepair(rift(this).store, "holder", "ally", eased);
});
Then("the strain eases, but the memory stays", function () {
  const r = rift(this).store[bondKey("holder", "ally")]!;
  assert.ok(r.strain < rift(this).strain0);
  assert.equal(r.peakResentment, rift(this).peak0);
  assert.ok(freshness(row(this), 1) < rift(this).fresh0);
  assert.equal(row(this).peak, 0.5);
});

// PR 3: bitter jurors, through the real adapter at a real Final-2 finale (roles only).
import { liveFinale, JURY9 } from "../support/liveFinale";
import { PLAYER, npc } from "../../src/domain/ids";
import { bitterJurorExtra } from "../../src/engine/jury";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

type Bitter = { fresh: number; old: number; none: number };
const lean = async (user: string, week: number, grudgeWeek: number | null): Promise<number> => {
  const { reg } = await liveFinale(user, 3, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const live = snap.live as unknown as { week: number; playedGame?: boolean; grudges?: GrudgeBook };
  live.week = week; live.playedGame = true;
  if (grudgeWeek !== null) live.grudges = { [`${JURY9[0]}|${PLAYER}`]: { kind: "cut-by-ally", week: grudgeWeek, day: 1, severity: 0.9, peak: 0.9, eased: 0, refKey: "k" } };
  reg.restore(user, snap);
  return (reg.sandboxFor(user).session as GameSessionAdapter).juryGrudgeFor(JURY9[0]!, PLAYER);
};
Given("a juror whose ally cut them and who now sits on the jury against that ally", async function () {
  (this as { bitter0182?: Bitter }).bitter0182 = { fresh: await lean("bj-f", 60, 60), old: await lean("bj-o", 60, 1), none: await lean("bj-n", 60, null) };
});
Then("at the finale the juror leans against that finalist", function () { const b = (this as unknown as { bitter0182: Bitter }).bitter0182; assert.equal(b.none, 0); assert.ok(b.fresh < 0); });
Then("the lean is sharper when the grudge is fresh than when it is old", function () { const b = (this as unknown as { bitter0182: Bitter }).bitter0182; assert.ok(b.fresh < b.old); });
Then("the lean is still there when the grudge is old", function () { assert.ok((this as unknown as { bitter0182: Bitter }).bitter0182.old < 0); });
Then("a wrong the juror's manner grievance already counts adds only the part beyond it", function () {
  const b = (this as unknown as { bitter0182: Bitter }).bitter0182;
  const covered = 0.8 * 0.6; // the betrayed manner term at its weight
  assert.ok(b.fresh < 0);
  // ORW-957: a grudge no deeper than the grievance adds nothing (an old, faded one); a deeper one adds exactly the part beyond it, never counted twice
  assert.equal(Math.abs(bitterJurorExtra(b.old, covered)), Math.max(0, Math.abs(b.old) - covered));
  assert.equal(Math.abs(bitterJurorExtra(b.fresh, covered)), Math.max(0, Math.abs(b.fresh) - covered));
  assert.equal(Math.abs(bitterJurorExtra(-covered / 2, covered)), 0); // (strictEqual reads -0 as unequal to 0: take the magnitude)
});
Then("a deal the finalist broke, which no manner counts, makes the juror lean against them by a real amount", async function () {
  const user = "bj-deal";
  const { reg } = await liveFinale(user, 3, { finalists: [PLAYER, npc(10)], jury: JURY9 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const live = snap.live as unknown as { playedGame?: boolean; evictionOrder: string[] };
  live.playedGame = true; live.evictionOrder = []; // still in the house when the deal breaks
  reg.restore(user, snap);
  const a = reg.sandboxFor(user).session as unknown as { juryGrudgeFor(j: string, f: string): number; deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { status: string; brokenBy?: string } }; grudgeOf(h: string, s: string): unknown; live: { evictionOrder: string[] } };
  const d = a.deals.make([JURY9[0]!, PLAYER], "safety", "terms", undefined, 1); d.status = "broken"; d.brokenBy = PLAYER;
  (a as unknown as { foldAtCommit(): void }).foldAtCommit(); // ORW-684: reads no longer fold; the commit's fold runs first, as the funnel would
  a.grudgeOf(JURY9[0]!, PLAYER);
  a.live.evictionOrder = [...JURY9];
  const lean = a.juryGrudgeFor(JURY9[0]!, PLAYER);
  assert.ok(lean < -0.01, `the grudge leans the juror away by ${lean}`);
  assert.equal(a.juryGrudgeFor(JURY9[1]!, PLAYER), 0); // a juror nobody wronged is untouched
});
