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

// ---- Part 2: the player as a juror ----
import type { ClaimInput } from "../../src/engine/spokenClaims";
import { liesBy } from "../../src/engine/spokenClaims";
import { PLAYER } from "../../src/domain/ids";

const OTHER_FINALIST = npc(9);
const claim = (speaker: string, listener: string, over: Partial<ClaimInput> = {}): ClaimInput =>
  ({ speaker, listener, kind: "going-after", subject: FINALIST, object: listener, isTrue: false, intent: "inform", ...over }) as ClaimInput;
function playerGame(playerJuror: boolean) {
  const g = game(true);
  const o = [npc(10), npc(11), npc(12), npc(13), npc(15)];
  if (playerJuror) { g.i.live.evictionOrder = [...o, PLAYER, ...JURORS.slice(0, 8)]; g.i.live.active = [OTHER_FINALIST, FINALIST]; }
  else g.i.live.evictionOrder = [...o, ...JURORS]; // the jurors are out, the player still in the house
  return g.i;
}
const tellUntil = (i: any, juror: string): unknown => {
  for (let n = 0; n < 120; n++) { i.live.dayNumber = 100 + n; i.disclosureEpoch = (i.disclosureEpoch ?? 0) + 1; const t = i.claimsToPlayerFor(juror, true); if (t) return t; }
  return undefined;
};

Given("a game where the player holds a juror's seat", function () { Object.assign(w(this), { i: playerGame(true) }); });
Then("a juror and the player can tell each other things", function () {
  const i = w(this).i;
  assert.ok(i.tellClaim(claim(npc(1), PLAYER)));
  assert.ok(i.tellClaim(claim(PLAYER, npc(2))));
});
Then("nobody still in the house can tell, or be told by, a juror or the player", function () {
  const i = w(this).i;
  for (const [a, b] of [[FINALIST, PLAYER], [PLAYER, FINALIST], [npc(1), FINALIST], [FINALIST, npc(1)]]) assert.equal(i.tellClaim(claim(a!, b!, { subject: npc(3) })), undefined);
});
Given("a game where the player is still in the house and a juror holds a belief", function () {
  const i = playerGame(false);
  i.live.beliefs[npc(1)] = [mkBelief(npc(1))];
  Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
  Object.assign(w(this), { i });
});
Then("no juror tells the player anything and the player can tell no juror anything", function () {
  const i = w(this).i;
  assert.equal(i.tellClaim(claim(npc(1), PLAYER)), undefined);
  assert.equal(i.tellClaim(claim(PLAYER, npc(1))), undefined);
  assert.equal(tellUntil(i, npc(1)), undefined);
});
const mkBelief = (holder: string): BeliefClaim => ({ id: `${holder}|b`, holder, kind: "targets-me", subject: FINALIST, object: holder, value: true, origin: "told", confidence: 0.8, week: 1 });
Given("a game where the player holds a juror's seat and a juror holds a belief", function () {
  const i = playerGame(true);
  i.live.beliefs[npc(1)] = [mkBelief(npc(1))];
  Object.assign(i.rel.edge(npc(1), PLAYER), { trust: 0.95 });
  Object.assign(w(this), { i });
});
When("that juror confides in the player", function () { (w(this) as W & { heard?: unknown }).heard = tellUntil(w(this).i, npc(1)); });
Then("what the player hears has only the kind, the names and a certainty band", function () {
  const h = (w(this) as W & { heard?: Record<string, unknown> }).heard!;
  assert.ok(h);
  assert.deepEqual(Object.keys(h).sort(), ["certainty", "kind", "object", "subject"]);
});
Given("a game where the player holds a juror's seat and a recorded ballot but no juror holds a belief", function () {
  const i = playerGame(true);
  i.live.voteRecord = [{ week: 3, evictee: npc(1), voteOf: { [npc(2)]: npc(1), [npc(3)]: npc(1) } }];
  for (const j of JURORS.slice(0, 8)) Object.assign(i.rel.edge(j, PLAYER), { trust: 0.95 });
  Object.assign(w(this), { i });
});
Then("no juror tells the player anything", function () {
  const i = w(this).i;
  for (const j of JURORS.slice(0, 8)) assert.equal(tellUntil(i, j), undefined);
});
When("the player tells a juror something false in their own words", function () {
  const i = w(this).i;
  (w(this) as W & { told?: unknown[] }).told = i.tellNarratedClaim({ kind: "going-after", subject: FINALIST, object: npc(2) }, PLAYER, [npc(2)], [npc(2)]);
});
Then("the juror holds it as told by the player and it is a lie on the record", function () {
  const i = w(this).i;
  assert.ok((i.live.beliefs[npc(2)] ?? []).some((b: BeliefClaim) => b.source === PLAYER && b.origin === "told"));
  assert.equal(liesBy(i.live.claims, PLAYER).length, 1);
});
