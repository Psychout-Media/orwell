import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { FAVOR } from "../../src/engine/favorConstants";
import { negotiate, weighCounter, type CounterSide } from "../../src/engine/favorCounters";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";
import { counterStreamKey } from "../../src/engine/favorCounters";
import { playedSession, sessionWithRoll, warm, cold, setEdge, ledger, gather, type Played } from "../../tests/support/favorsSeam";

/**
 * Feature 0171 - counters and the favor economy. The counter scenarios drive the pure module; every ledger scenario drives the REAL adapter through a registry sandbox (tests/support/favorsSeam.ts).
 * Every step carries the "favors:" prefix or a "favors season" Given, so no wording collides with another feature. Roles only.
 */
type Bag = {
  p?: Played; holder?: string; debtor?: string; w1?: string; w2?: string; bystander?: string; other?: string;
  side?: CounterSide; negotiation?: ReturnType<typeof negotiate>; round?: ReturnType<typeof weighCounter>;
  trust?: Record<string, number>; runs?: string[]; share?: number; savedCount?: number; core?: unknown; second?: Played; offIdle?: boolean;
};
const bag = (w: unknown): Bag => ((w as { fav0171?: Bag }).fav0171 ??= {});
const side = (id: string, goalTarget: string | undefined, goalPull: number, protects: string[] = []): CounterSide =>
  ({ id, ...(goalTarget ? { goalTarget } : {}), goalPull, bond: 0.5, pullOn: (t) => (protects.includes(t) ? -0.5 : 0.3) });
const eager = { counter: 0, settle: 0 };

Given("a favors season where an NPC who wants a rival gone is offered safety", function () {
  bag(this).side = side("npc", "rival", 0.8);
  bag(this).round = weighCounter({ round: 1, side: bag(this).side!, rolls: eager });
});
Then("favors: the NPC counters that they will take it if the rival goes up", function () {
  const r = bag(this).round!;
  assert.equal(r.verdict, "counter");
  assert.deepEqual(r.ask, { kind: "target", target: "rival" });
  assert.equal(r.round, 1);
});

Given("a favors season where an NPC counters an offer and the offerer counters back", function () {
  const responder = side("responder", "rivalA", 0.8, ["rivalB"]);
  const offerer = side("offerer", "rivalB", 0.8, ["rivalA"]);
  bag(this).negotiation = negotiate(offerer, responder, () => eager);
});
Then("favors: the two trade more than one counter before it settles or falls through", function () {
  const n = bag(this).negotiation!;
  assert.ok(n.rounds.filter((r) => r.verdict === "counter").length >= 2, "only one counter was traded");
  assert.ok(n.rounds.length >= 2);
});
Then("favors: no round is ever more than the bounded limit", function () {
  const n = bag(this).negotiation!;
  assert.ok(n.rounds.length <= FAVOR.maxCounterRounds);
  assert.ok(n.rounds.every((r) => r.round <= FAVOR.maxCounterRounds));
  assert.notEqual(n.rounds[n.rounds.length - 1]!.verdict, "counter", "the last allowed round must settle or fall through");
});

function owed(w: unknown, outcome: "honor" | "refuse", witnesses = false): void {
  const b = bag(w);
  const p = sessionWithRoll(outcome);
  b.p = p;
  [b.holder, b.debtor, b.w1, b.w2, b.bystander, b.other] = p.npcs;
  const rec = p.session.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:origin", ...(witnesses ? { witnesses: [b.w1!, b.w2!] } : {}) });
  assert.ok(rec, "the favor was not recorded");
  (outcome === "honor" ? warm : cold)(p, b.debtor!, b.holder!);
  gather(p, [b.holder!, b.debtor!, b.w1!, b.w2!]); // the two who heard it promised are in the room, awake, when it is refused
  for (const x of [b.w1!, b.w2!, b.bystander!]) setEdge(p, x, b.debtor!, { trust: 0.7, affinity: 0.7, threat: 0.1 });
  setEdge(p, b.holder!, b.debtor!, { trust: 0.7, affinity: 0.7, threat: 0.1 });
  b.trust = Object.fromEntries([b.holder!, b.w1!, b.w2!, b.bystander!].map((x) => [x, p.seam.rel.edge(x, b.debtor!).trust]));
}
const tally = (b: Bag): void => { b.p!.seam.favorsAtTally([b.holder!, b.other!], [b.debtor!, b.w1!, b.w2!, b.bystander!]); };

Given("a favors season where an NPC owes a houseguest a favor and a vote is close", function () { owed(this, "honor"); });
When("favors: the houseguest is on the block and the favor is called in", function () { tally(bag(this)); });
Then("favors: the NPC repays it with their vote and the favor is cleared", function () {
  const b = bag(this);
  const f = ledger(b.p!).find((x) => x.owedBy === b.debtor && x.holder === b.holder)!;
  assert.equal(f.state, "repaid");
  assert.ok(f.calledBeat !== undefined);
  assert.equal(b.p!.session.favorLedger().filter((x) => x.state === "owed").length, 0);
});

Given("a favors season where an NPC owes a houseguest a favor, and two others heard it promised", function () { owed(this, "refuse", true); });
When("favors: the NPC refuses it when called in", function () {
  const b = bag(this);
  tally(b);
  assert.equal(ledger(b.p!).find((x) => x.owedBy === b.debtor)!.state, "refused");
});
Then("favors: the houseguest trusts the NPC less, and so do the two witnesses, at a lower weight", function () {
  const b = bag(this); const seam = b.p!.seam;
  const drop = (x: string): number => b.trust![x]! - seam.rel.edge(x, b.debtor!).trust;
  assert.ok(drop(b.holder!) > 0, "the holder's trust did not fall");
  assert.ok(drop(b.w1!) > 0 && drop(b.w2!) > 0, "a witness's trust did not fall");
  assert.ok(drop(b.w1!) < drop(b.holder!), "a witness weighs it at the holder's weight or more");
});
Then("favors: a houseguest who never heard it is unchanged", function () {
  const b = bag(this);
  assert.equal(b.p!.seam.rel.edge(b.bystander!, b.debtor!).trust, b.trust![b.bystander!]);
});

Given("a favors season where a houseguest passes a favor owed to them on to another", function () {
  const b = bag(this);
  const p = sessionWithRoll("honor");
  b.p = p;
  [b.holder, b.debtor, b.w1, b.w2, b.bystander, b.other] = p.npcs;
  p.session.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:origin" });
  warm(p, b.debtor!, b.w1!);
  setEdge(p, b.holder!, b.w1!, { trust: 0.95, affinity: 0.95, threat: 0 });
  // the holder is off the block; their close ally is a nominee at a close vote
  p.seam.favorsAtTally([b.w1!, b.other!], [b.debtor!, b.holder!, b.bystander!]);
});
Then("favors: the new holder can call it in, and the original debtor is remembered", function () {
  const b = bag(this);
  const all = ledger(b.p!);
  const old = all.find((f) => f.owedBy === b.debtor && f.holder === b.holder)!;
  assert.equal(old.state, "passed");
  const next = all.find((f) => f.passedFrom === old.id)!;
  assert.equal(next.holder, b.w1);
  assert.equal(next.owedBy, b.debtor, "the original debtor was lost");
  assert.equal(next.owedTo, b.holder, "whose it was originally was lost");
  assert.ok(next.calledBeat !== undefined, "the new holder could not call it in");
});

Given("a favors season where a houseguest is owed a favor by another", function () {
  const b = bag(this);
  const p = playedSession(6); b.p = p;
  [b.holder, b.debtor] = p.npcs;
  p.session.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:origin" });
});
Then("favors: the bond record shows the debt on the holder's side, and the reverse view the opposite", function () {
  const b = bag(this); const r = b.p!.session.bondReader();
  assert.ok(r.bond(b.holder!, b.debtor!).debt > 0, "the holder reads no debt owed");
  assert.ok(r.bond(b.debtor!, b.holder!).debt < 0, "the debtor reads no debt owed");
});

Given("a favors season where several favors are owed and repaid", function () {
  const b = bag(this);
  const p = sessionWithRoll("honor"); b.p = p;
  [b.holder, b.debtor, b.w1, b.w2, b.bystander, b.other] = p.npcs;
  p.session.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:origin", witnesses: [b.w1!] });
  p.session.recordFavor({ owedBy: b.w1!, owedTo: PLAYER, origin: "deal:other" });
  warm(p, b.debtor!, b.holder!);
  tally(b);
});
Then("favors: no player or admin view carries a favor count, a debt figure or a ledger", async function () {
  const sb = bag(this).p!.sb;
  const out = JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/owedBy|owedTo|calledBeat|passedFrom|favor:\d+|"favors"|"debt"/.test(out), "a favor field reached a player or admin view");
});

function twoRuns(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = playedSession(11);
    const [h, d, a, c] = p.npcs;
    p.session.recordFavor({ owedBy: d!, owedTo: h!, origin: "deal:origin", witnesses: [a!] });
    setEdge(p, d!, h!, { trust: 0.5, affinity: 0.5, threat: 0.3 });
    p.seam.favorsAtTally([h!, c!], [d!, a!]);
    const r = negotiate(side("o", "x", 0.7, ["y"]), side("r", "y", 0.7, ["x"]), (round) => { const g = new SeededRandom(hashSeed(counterStreamKey(11, "deal:1", 1, round))); return { counter: g.next(), settle: g.next() }; });
    out.push(JSON.stringify([p.session.favorLedger(), r]));
  }
  return out;
}
Given("a favors season played twice from the same seed", function () { bag(this).runs = twoRuns(); });
Then("favors: both runs hold the same counters and favors in the same order", function () { const r = bag(this).runs!; assert.equal(r[0], r[1]); });
Then("favors: across many seeds the share of counters that fall through sits inside the reported band", function () {
  // A mixed house: each pair's goals, pulls, bonds and who they protect are drawn from the seed (some have no goal at all, some protect the other's rival, some do not).
  let fell = 0; const N = 400;
  for (let seed = 0; seed < N; seed++) {
    const rolls = (round: number) => { const g = new SeededRandom(hashSeed(counterStreamKey(seed, "deal:1", 1, round))); return { counter: g.next(), settle: g.next() }; };
    const g = new SeededRandom(hashSeed(`mix:${seed}`));
    const mk = (id: string, mine: string, theirs: string): CounterSide => {
      const wants = g.next() < 0.6; const pull = 0.1 + 0.7 * g.next(); const protects = g.next() < 0.4;
      return { id, ...(wants ? { goalTarget: mine } : {}), goalPull: wants ? pull : 0, bond: g.next(), pullOn: (t) => (protects && t === theirs ? -0.5 : 0.3) };
    };
    if (!negotiate(mk("o", "x", "y"), mk("r", "y", "x"), rolls).settled) fell++;
  }
  const share = fell / N;
  console.log(`FAVORS0171 fall-through share ${share.toFixed(3)} over ${N} seeds`);
  assert.ok(share > 0.1 && share < 0.7, `the share of counters that fall through (${share}) left the band`);
});

Given("a favors season with one favor owed, one repaid and one refused", function () {
  const b = bag(this);
  const p = playedSession(6); b.p = p;
  [b.holder, b.debtor, b.w1, b.w2] = p.npcs;
  const s = p.session;
  s.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:a" });
  s.recordFavor({ owedBy: b.w1!, owedTo: b.holder!, origin: "deal:b", witnesses: [b.w2!] });
  s.recordFavor({ owedBy: b.w2!, owedTo: b.holder!, origin: "deal:c" });
  const led = s as unknown as { favors: { resolve(id: string, st: "repaid" | "refused", beat: number): boolean } };
  led.favors.resolve("favor:2", "repaid", 1);
  led.favors.resolve("favor:3", "refused", 1);
});
When("favors: the season is saved and loaded into a fresh session", function () {
  const b = bag(this);
  b.savedCount = ledger(b.p!).length;
  b.core = JSON.parse(JSON.stringify(b.p!.session.snapshot()));
  const sb2 = new GameSessionRegistry().sandboxFor("favors0171-restore");
  sb2.session.restore(b.core as never);
  b.second = { ...b.p!, sb: sb2, session: sb2.session };
});
Then("favors: the loaded session holds every favor it held before, and a later save never holds fewer", function () {
  const b = bag(this);
  assert.deepEqual(b.second!.session.favorLedger(), b.p!.session.favorLedger());
  assert.deepEqual(b.second!.session.favorLedger().map((f) => f.state), ["owed", "repaid", "refused"]);
  const core = b.second!.session.snapshot() as unknown as { favors?: unknown[] };
  assert.ok((core.favors?.length ?? 0) >= b.savedCount!);
  assert.equal(b.second!.session.recordFavor({ owedBy: b.w1!, owedTo: b.debtor!, origin: "deal:d" })?.id, "favor:4", "the sequence did not recompute");
});

Given("a favors season with the favor economy switched off", function () {
  const b = bag(this);
  const p = playedSession(6, { favors: false }); b.p = p;
  [b.holder, b.debtor] = p.npcs;
  b.offIdle = p.session.recordFavor({ owedBy: b.debtor!, owedTo: b.holder!, origin: "deal:origin" }) === undefined;
});
Then("favors: no favor is recorded and a swap offer carries no counter", function () {
  const b = bag(this);
  assert.ok(b.offIdle, "a favor was recorded with the flag off");
  assert.equal(ledger(b.p!).length, 0);
  const core = b.p!.session.snapshot() as unknown as { favors?: unknown };
  assert.equal(core.favors, undefined, "the snapshot carries a favors key with the flag off");
  assert.equal(b.p!.session.bondReader().bond(b.holder!, b.debtor!).debt, 0);
});

Given("a favors season where the player is owed a favor and a vote is close", function () {
  const b = bag(this);
  const p = sessionWithRoll("honor"); b.p = p;
  [b.holder, b.debtor, b.other] = p.npcs;
  p.session.recordFavor({ owedBy: b.debtor!, owedTo: PLAYER, origin: "bank:1" });
  p.seam.favorsAtTally([b.debtor!, b.other!], [PLAYER]);
});
Then("favors: the engine does not call it in for the player", function () {
  const f = ledger(bag(this).p!)[0]!;
  assert.equal(f.state, "owed");
  assert.equal(f.calledBeat, undefined);
});

Given("a favors season where the player owes a houseguest a favor and a vote is close", function () {
  const b = bag(this);
  const p = playedSession(6); b.p = p;
  [b.holder, b.other] = p.npcs;
  p.session.recordFavor({ owedBy: PLAYER, owedTo: b.holder!, origin: "counter:1" });
  p.seam.favorsAtTally([b.holder!, b.other!], [PLAYER]);
});
Then("favors: the houseguest asks the player for it through the one standing offer, and the player answers", function () {
  const b = bag(this);
  const offer = b.p!.session.getGameState().openDealOffer!;
  assert.equal(offer.from.id, b.holder);
  assert.deepEqual(offer.favor, { kind: "called-in" });
  b.p!.seam.resolveDealOffer(true);
  assert.equal(ledger(b.p!)[0]!.state, "repaid");
});

Given("a favors season where the player accepts a counter that a rival goes up", function () {
  const b = bag(this);
  const p = playedSession(6); b.p = p;
  [b.holder, b.other, b.w1] = p.npcs;
  p.seam.live.dealOffer = { id: "offer:x:1", from: b.holder!, kind: "vote", terms: "t", madeWeek: p.seam.live.week, counter: { round: 1, ask: { kind: "target", target: b.other! } } };
  p.seam.resolveDealOffer(true);
});
Then("favors: the player owes nothing until the rival is actually on the block", function () {
  const b = bag(this);
  assert.equal(ledger(b.p!).length, 0);
  b.p!.seam.favorsAtTally([b.w1!, b.holder!], [PLAYER]);
  assert.equal(ledger(b.p!).length, 0, "booked although the rival never went up");
});
