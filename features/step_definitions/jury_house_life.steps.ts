import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { planJuryNotes } from "../../src/engine/juryNotes";
import { buildSandbox } from "../../tests/support/sandbox";
import { npc } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/** Feature 0189 - jury-house life. Roles only: teller = npc:1, listener/wronged = npc:2, finalist = npc:14. */
const JURORS = Array.from({ length: 9 }, (_, i) => npc(i + 1));
const FINALIST = npc(14);
const mk = (kind: BeliefClaim["kind"]): BeliefClaim => ({ id: `t|${kind}`, holder: npc(1), kind, subject: FINALIST, value: true, origin: "witnessed", confidence: 0.8, week: 1 });
type W = { held?: BeliefClaim[]; out?: ReturnType<typeof planJuryNotes>; counts?: [number, number]; i?: any; deal?: any; before?: number };
const w = (x: unknown): W => x as W;
const plan = (held: BeliefClaim[], open: number, rolls: () => number) => planJuryNotes({ jurors: [npc(1), npc(2)], beliefs: { [npc(1)]: held }, talks: () => true, opennessOf: () => open, rng: { next: rolls } as never });

function game(played: boolean) {
  const sb = buildSandbox(189);
  const s = new GameSessionAdapter();
  s.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  s.createCharacter({ playerName: "The Player", seed: 189 });
  s.noteMessage({ messageId: "m-1" } as never);
  s.setJuryHouseEnabled(true);
  const i = s as any;
  i.live.evictionOrder = [npc(10), npc(11), npc(12), npc(13), npc(15), ...JURORS];
  i.live.playedGame = played;
  i.live.beliefs = {};
  for (const a of JURORS) for (const b of JURORS) if (a !== b) Object.assign(i.rel.edge(a, b), { affinity: 0.9, trust: 0.6 });
  return { i, sb };
}

Given("a juror who holds that a finalist lied to them", function () { w(this).held = [mk("lied-to-me")]; });
Given("a juror who holds a read of who voted against them", function () { w(this).held = [mk("voted-against-me")]; });
When("the jurors compare notes and the teller is open", function () { w(this).out = plan(w(this).held!, 1.4, () => 0); });
Then("another juror comes to hold it at a slightly lower confidence", function () {
  const o = w(this).out!;
  assert.equal(o.length, 1);
  assert.equal(o[0]!.kind, "lied-to-me");
  assert.ok(o[0]!.confidence < 0.8);
});
Then("nothing is passed on", function () { assert.deepEqual(w(this).out, []); });
When("the jurors compare notes many times with a guarded teller and with an easygoing teller", function () {
  const tally = (open: number): number => {
    let n = 0;
    for (let s = 0; s < 200; s++) { let k = 0; n += plan(w(this).held!, open, () => { k += 1; return ((s * 7919 + k * 104729) % 1000) / 1000; }).length; }
    return n;
  };
  w(this).counts = [tally(0.35), tally(1.4)];
});
Then("the easygoing teller passes more on", function () { const [g, e] = w(this).counts!; assert.ok(e > g); });

Given("a played game whose jury has a juror wronged by a finalist's quiet deal break", function () {
  const g = game(true);
  const deal = g.i.deals.make([npc(2), FINALIST], "safety", "you are safe with me", undefined, 1);
  deal.status = "broken"; deal.brokenBy = FINALIST; deal.learned = false;
  g.i.live.beliefs[npc(1)] = [mk("lied-to-me")];
  Object.assign(w(this), { i: g.i, deal, before: g.i.rel.edge(npc(2), FINALIST).trust });
});
When("another juror tells them the finalist lied", function () {
  const i = w(this).i;
  for (let n = 0; n < 60 && w(this).deal.learned !== true; n++) { i.juryHouseTickCount += 1; i.juryLife(JURORS); }
});
Then("the wronged juror has learned of the break and trusts the finalist less", function () {
  assert.equal(w(this).deal.learned, true);
  assert.ok(w(this).i.rel.edge(npc(2), FINALIST).trust < w(this).before!);
});

Given("an unplayed game whose jury has a juror who holds that a finalist lied to them", function () {
  const g = game(false);
  g.i.live.beliefs[npc(1)] = [mk("lied-to-me")];
  Object.assign(w(this), { i: g.i, sb: g.sb });
});
When("the jury house runs its stretches", function () { const x = w(this) as W & { sb: any }; x.i.juryHouseTick(x.sb.engine.events, x.sb.engine.knowledge); });
Then("no juror is told anything", function () {
  const told = JURORS.some((j) => (w(this).i.live.beliefs[j] ?? []).some((c: BeliefClaim) => c.origin === "told"));
  assert.equal(told, false);
});
