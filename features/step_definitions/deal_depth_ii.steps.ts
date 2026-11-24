import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DealLedger, type ReconcileSink } from "../../src/engine/deals";
import type { Deal } from "../../src/domain/deal";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { DEAL_TEMPTATION } from "../../src/engine/dealTemptationConstants";
import type { Agenda } from "../../src/engine/agenda";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { DealRefusal, DealView } from "../../src/ports/GameSession";
import { resolvePending } from "../support/answerPending";
/** ORW-608: the REAL refusal reason is engine-only (never on the outward object); steps read it through the adapter's private map (TEST-ONLY seam). */
const realReason = (g: unknown, r: unknown): string | undefined => (r ? (g as { refusalReal: WeakMap<object, string> }).refusalReal.get(r as object) : undefined);

// Feature 0142 - Deal depth II (ORW-88): counteroffers, owed favors, conditional / information / package deals, NPCs weighing a break.
// Roles only. Every scenario drives the REAL live adapter of a fresh registry sandbox, flagged as a PLAYED game (a person is playing),
// the way the unit gates do (dealCounteroffer / owedFavors / conditionalDeal / informationDeal / packageDeal / dealBreakWeighing);
// the package-cost comparison runs on the real DealLedger + RelationshipModel.

type Edge = { trust: number; affinity: number; threat: number };
type Internals = {
  rel: { edge(a: string, b: string): Edge };
  live: {
    playedGame?: boolean; week: number; hoh?: string; pending?: unknown; active: string[];
    dealOffer?: { id: string; from: string; kind: string; replacesDealId?: string; madeWeek: number };
    owedFavors?: Array<{ debtor: string; n: number; madeWeek: number }>;
    agendas?: Record<string, Agenda>;
    decisionWhy?: Array<{ kind: string; by: string }>;
    statedReasons?: Array<{ decision: string; public: boolean }>;
  };
  deals: DealLedger;
  presence: Map<string, string> | null;
  dealConsentRefusal(npc: string, kind: string, direction?: "offer" | "ask"): DealRefusal | null;
  setNpcDealOffersEnabled(on: boolean): void;
  setNpcDealConsentEnabled(on: boolean): void;
  setDealDepthEnabled(on: boolean): void;
  bankOwedFavor(honorer: string, honored: string): void;
  reconcileDeals(a: unknown): void;
  deliverInformationDeals(): void;
  weighDealBreaks(): void;
  resolveDealOffer(accept: boolean): unknown;
  statedReasonsFor(id: string): Array<Record<string, unknown>>;
};

interface Live { sb: UserSandbox; s: GameSessionAdapter; g: Internals; npc: EntityId; others: EntityId[] }
interface Weigh { s: GameSessionAdapter; g: Internals; npc: EntityId; deal: Deal }
interface Ctx {
  live?: Live;
  refusal?: DealRefusal;
  offerId?: string;
  deal?: Deal;
  favor?: { honored: boolean } | null;
  trustBefore?: number;
  eventsBefore?: number;
  vaultSentinel?: string;
  packageGain?: { packaged: number; plain: number };
  weigh?: Weigh;
  sweeps?: { breaker: Sweep; keeper: Sweep };
  verdicts?: string[];
  headless?: { live: Live; before: string; after?: string; outs: unknown[] };
}
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = {}; state.set(w, c); } return c; };

/** A live game two beats in, deal consent + deal depth + NPC offers on, flagged played (or not). */
function game(played = true, tag = "ddii"): Live {
  const sb = new GameSessionRegistry().sandboxFor(`${tag}-fixed`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Internals;
  g.setNpcDealConsentEnabled(true); g.setDealDepthEnabled(true); g.setNpcDealOffersEnabled(true);
  g.live.playedGame = played;
  const [first, ...others] = sb.session.livingIds().filter((i) => i !== PLAYER) as EntityId[];
  return { sb, s: sb.session, g, npc: first!, others };
}
const setEdge = (g: Internals, from: string, to: string, e: Edge): void => { Object.assign(g.rel.edge(from, to), e); };
const dealsWith = (l: Live, who: string): DealView[] => (l.s.getGameState().deals ?? []).filter((d) => d.parties.some((p) => p.id === who));
const LUKEWARM: Edge = { trust: 0.25, affinity: 0.25, threat: 0.3 }; // a typical-newcomer read: an active ask is too dear, a mutual safety pact is fine
const WARM: Edge = { trust: 0.7, affinity: 0.7, threat: 0.1 };
const askThrow = (l: Live) => l.s.makeDeal({ with: l.npc, kind: "comp-throw", direction: "ask", terms: "throw the next comp" } as never) as DealRefusal | DealView | null;

function lukewarm(): Live {
  const l = game(true, "counter");
  setEdge(l.g, l.npc, PLAYER, LUKEWARM);
  assert.equal(realReason(l.g, l.g.dealConsentRefusal(l.npc, "comp-throw", "ask")), "cost", "the ask is refused for cost alone");
  assert.equal(l.g.dealConsentRefusal(l.npc, "safety"), null, "the NPC would take a safety pact");
  return l;
}

// --- 1. Counteroffers ------------------------------------------------------------------------------------------------------

Given("a played game and an NPC who would refuse a comp-throw ask only because it costs too much", function (this: BbWorld) {
  st(this).live = lukewarm();
});

When("the player asks that NPC to throw a competition", function (this: BbWorld) {
  const c = st(this);
  c.refusal = askThrow(c.live!) as DealRefusal;
});

Then("the ask is refused and the NPC counters with the safety pact the engine says it would take", function (this: BbWorld) {
  const c = st(this);
  assert.equal(c.refusal?.refused, true);
  assert.equal(realReason(c.live!.g, c.refusal), "cost"); // ORW-608: the real reason is engine-only; the outward one is what the NPC says
  assert.equal(c.refusal?.counteroffer?.kind, "safety");
});

Then("the counteroffer stands as open state voiced in chat, with no pop-up decision and no deal yet", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  const view = l.s.getGameState();
  assert.equal(view.openDealOffer?.from.id, l.npc, "the counteroffer is the standing open offer");
  assert.equal(view.openDealOffer?.kind, "safety");
  assert.ok(view.openDealOffer?.howToVoice, "it carries the narrator's voicing instruction (voiced in chat)");
  assert.notEqual(view.pending?.kind, "deal-offer", "never a pop-up decision");
  assert.equal(dealsWith(l, l.npc).length, 0, "no deal until the player answers");
  c.offerId = l.g.live.dealOffer!.id;
});

Then("the counteroffer lapses unanswered when the week rolls, with no deal made from it", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  const made = l.g.live.dealOffer!.madeWeek;
  // A played game holds an ordinary beat until its in-game milestone is due (the A65 schedule gate, its own feature); the player
  // spending the week is not what this scenario is about, so lift that gate and let the week play out to its roll.
  (l.s as unknown as { setAdvanceGateEnabled(on: boolean): void }).setAdvanceGateEnabled(false);
  for (let i = 0; i < 4000 && l.g.live.week <= made; i++) {
    const v = l.s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => l.s.submitDecision(req));
    if (v.finished) break;
  }
  assert.ok(l.g.live.week > made, "the week rolled");
  assert.notEqual(l.g.live.dealOffer?.id, c.offerId, "the counteroffer no longer stands");
  assert.ok(l.sb.engine.events.queryAll().some((e) => e.witnessSet.includes(PLAYER) && /lapsed unanswered/.test(e.content)), "the player witnesses the offer lapsing unanswered");
  assert.ok(!(l.s.getGameState().deals ?? []).some((d) => d.kind === "safety" && d.parties.some((p) => p.id === l.npc) && d.parties.some((p) => p.id === PLAYER)), "no safety deal came of it");
});

Given("an open counteroffer from an NPC in a played game", function (this: BbWorld) {
  const l = lukewarm();
  const r = askThrow(l) as DealRefusal;
  assert.equal(r.counteroffer?.kind, "safety");
  assert.equal(dealsWith(l, l.npc).length, 0);
  st(this).live = l;
});

When("the player accepts the counteroffer", function (this: BbWorld) {
  const l = st(this).live!;
  l.s.submitDecision({ kind: "deal-offer", vote: "accept" } as never);
});

When("the player declines the counteroffer", function (this: BbWorld) {
  const l = st(this).live!;
  l.s.submitDecision({ kind: "deal-offer", vote: "decline" } as never);
});

Then("an ordinary safety deal with that NPC is recorded and the offer no longer stands", function (this: BbWorld) {
  const l = st(this).live!;
  const deals = dealsWith(l, l.npc);
  assert.equal(deals.length, 1, "one ordinary deal was made");
  assert.equal(deals[0]!.kind, "safety");
  assert.equal(deals[0]!.status, "open");
  assert.equal(l.s.getGameState().openDealOffer ?? undefined, undefined);
});

Then("no deal with that NPC is recorded and the offer no longer stands", function (this: BbWorld) {
  const l = st(this).live!;
  assert.equal(dealsWith(l, l.npc).length, 0);
  assert.equal(l.s.getGameState().openDealOffer ?? undefined, undefined);
});

/** ONE bank (0171): the player's open favor claims from the favor ledger, grouped like the old `owedFavors` rows; undefined when nothing is owed. */
const bankOf = (s: unknown): Array<{ debtor: string; n: number }> | undefined => {
  const by = new Map<string, number>();
  for (const f of (s as { favorLedger(): ReadonlyArray<{ owedBy: string; holder: string; state: string }> }).favorLedger()) if (f.state === "owed" && f.holder === PLAYER) by.set(f.owedBy, (by.get(f.owedBy) ?? 0) + 1);
  return by.size ? [...by].map(([debtor, n]) => ({ debtor, n })) : undefined;
};

// --- 2. Owed favors --------------------------------------------------------------------------------------------------------

Given("a played game where an NPC promised the player to throw a competition", function (this: BbWorld) {
  const l = game(true, "favor");
  const c = st(this);
  c.live = l;
  c.deal = l.g.deals.make([l.npc, PLAYER], "comp-throw", "throw it", undefined, l.g.live.week);
  assert.equal(bankOf(l.s), undefined, "nothing is owed yet");
});

When("the NPC throws that competition", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.reconcileDeals({ actor: l.npc, kind: "compete", targets: [], outcome: "threw" });
});

Then("the deal is kept and the player holds a banked favor from that NPC", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.equal(c.deal!.status, "kept");
  assert.deepEqual(bankOf(l.s), [{ debtor: l.npc, n: 1 }]);
  assert.equal(l.s.getGameState().owedFavors?.[0]?.from.id, l.npc, "the player can see who owes them (no number of trust)");
});

Given("a played game where an NPC owes the player a favor and would refuse a comp-throw ask for cost alone", function (this: BbWorld) {
  const l = game(true, "favor");
  setEdge(l.g, l.npc, PLAYER, LUKEWARM);
  assert.equal(realReason(l.g, l.g.dealConsentRefusal(l.npc, "comp-throw", "ask")), "cost", "without the favor the ask is refused for cost");
  l.g.bankOwedFavor(l.npc, PLAYER);
  st(this).live = l;
});

Given("a played game where an NPC owes the player a favor but distrusts and fears the player", function (this: BbWorld) {
  const l = game(true, "favor");
  setEdge(l.g, l.npc, PLAYER, { trust: 0, affinity: 0, threat: 0.95 });
  l.g.bankOwedFavor(l.npc, PLAYER);
  st(this).live = l;
});

When("the player calls the favor in for a comp-throw", function (this: BbWorld) {
  const l = st(this).live!;
  st(this).favor = l.s.callInFavor(l.npc, "comp-throw");
});

When("the player calls the favor in for a vote", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  c.trustBefore = l.g.rel.edge(PLAYER, l.npc).trust;
  c.favor = l.s.callInFavor(l.npc, "vote");
});

Then("the engine has the NPC honor it with an ordinary deal and the favor is spent", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.equal(c.favor?.honored, true);
  const deals = dealsWith(l, l.npc);
  assert.equal(deals.length, 1);
  assert.equal(deals[0]!.kind, "comp-throw");
  assert.equal(bankOf(l.s), undefined, "the favor is spent");
  assert.equal(l.s.callInFavor(l.npc, "comp-throw"), null, "nothing left to call in");
});

Then("the engine has the NPC ignore it, no deal binds and the favor is spent", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.equal(c.favor?.honored, false);
  assert.equal(dealsWith(l, l.npc).length, 0);
  assert.equal(bankOf(l.s), undefined);
});

Then("the player's hidden trust in that NPC falls", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.ok(l.g.rel.edge(PLAYER, l.npc).trust < c.trustBefore!, "the player's own read of them drops");
});

// --- 3. Conditional ---------------------------------------------------------------------------------------------------------

Given("a played game with a conditional deal between the player and an NPC", function (this: BbWorld) {
  const l = game(true, "cond");
  setEdge(l.g, l.npc, PLAYER, WARM);
  const v = l.s.makeDeal({ with: l.npc, kind: "conditional", terms: "keep each other if on the block" } as never) as DealView;
  assert.equal(v?.kind, "conditional", "a willing NPC makes the conditional deal");
  const c = st(this);
  c.live = l;
  c.deal = l.g.deals.open().find((d) => d.kind === "conditional")!;
});

When("the NPC nominates the player", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.reconcileDeals({ actor: l.npc, kind: "nominate", targets: [PLAYER] });
});

When("the NPC votes to evict the player", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.reconcileDeals({ actor: l.npc, kind: "vote-evict", targets: [PLAYER], alternatives: [PLAYER, l.others[0]] });
});

When("the NPC votes out the other nominee while the player is on the block", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.reconcileDeals({ actor: l.npc, kind: "vote-evict", targets: [l.others[0]], alternatives: [PLAYER, l.others[0]] });
});

When("the week ends with no vote that tests it", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.deals.expireWeekScoped(l.g.live.week + 1);
});

Then("the conditional deal is still open", function (this: BbWorld) { assert.equal(st(this).deal!.status, "open"); });
Then("the conditional deal is broken", function (this: BbWorld) { assert.equal(st(this).deal!.status, "broken"); });
Then("the conditional deal is kept", function (this: BbWorld) { assert.equal(st(this).deal!.status, "kept"); });

Then("the conditional deal is neither kept nor broken and no longer binds", function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.ok(c.deal!.status !== "kept" && c.deal!.status !== "broken", `untested: neither kept nor broken (was ${c.deal!.status})`);
  assert.ok(!l.g.deals.open().includes(c.deal!), "no longer binding");
  // a later vote against the former partner is no betrayal: the pact is gone
  l.g.reconcileDeals({ actor: l.npc, kind: "vote-evict", targets: [PLAYER], alternatives: [PLAYER, l.others[0]] });
  assert.notEqual(c.deal!.status, "broken");
});

// --- 3. Information ---------------------------------------------------------------------------------------------------------

const INFO_FACT = "the third was seen packing a bag";
Given("a played game with an information deal from an NPC who holds a fact the player does not, and a sealed Vault secret about that NPC", function (this: BbWorld) {
  const l = game(true, "info");
  setEdge(l.g, l.npc, PLAYER, WARM);
  const third = l.others[0]!;
  l.sb.engine.knowledge.seedBelief(l.npc, { content: INFO_FACT, originalContent: INFO_FACT, factId: "fact:bdd-info-1", confidence: 0.9, hops: 0, distortion: 0, source: third, subject: third } as never, "origin");
  const sentinel = "VAULT-SENTINEL-BDD-0142-INFO";
  l.sb.engine.vault.writeHidden({ id: "v:bdd-info-attr", kind: "hidden-attribute", subject: l.npc, content: sentinel });
  assert.ok(l.sb.engine.vault.readHidden().some((r) => r.content === sentinel), "the sentinel really is sealed");
  const v = l.s.makeDeal({ with: l.npc, kind: "information", terms: "tell me what you hear" } as never) as DealView;
  assert.equal(v?.kind, "information");
  const c = st(this);
  c.live = l; c.vaultSentinel = sentinel;
  c.deal = l.g.deals.open().find((d) => d.kind === "information")!;
});

const playerKnows = (l: Live): string[] => l.sb.engine.knowledge.knownTo(PLAYER).map((f) => f.content);

When("the NPC and the player are in different rooms on a beat", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.presence = new Map([[PLAYER, "room:a"], [l.npc, "room:b"]]);
  l.g.deliverInformationDeals();
});

When("the NPC and the player are in the same room on a beat", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.presence = new Map([[PLAYER, "room:a"], [l.npc, "room:a"]]);
  l.g.deliverInformationDeals();
  l.g.deliverInformationDeals(); // a second beat together: an already-held fact is not passed again
});

Then("nothing is passed to the player", function (this: BbWorld) {
  const c = st(this);
  assert.ok(!playerKnows(c.live!).includes(INFO_FACT));
  assert.equal(c.deal!.delivered, undefined);
});

Then("the NPC's held fact reaches the player, once", function (this: BbWorld) {
  const c = st(this);
  assert.ok(playerKnows(c.live!).includes(INFO_FACT), "the told fact reached the player");
  assert.equal(c.deal!.delivered, 1);
});

Then("the sealed Vault secret reaches no player surface", async function (this: BbWorld) {
  const c = st(this); const l = c.live!;
  assert.ok(!JSON.stringify(l.sb.engine.knowledge.knownTo(PLAYER)).includes(c.vaultSentinel!));
  for (const tool of ["getGameState", "getVisibleStateFor", "getMomentPrompt"]) {
    const out = await l.sb.mcp.player.callTool(tool, tool === "getVisibleStateFor" ? { id: PLAYER } : {});
    assert.ok(!JSON.stringify(out).includes(c.vaultSentinel!), `${tool} carries no Vault content`);
  }
  assert.ok(!JSON.stringify(l.sb.engine.events.queryAll().filter((e) => e.witnessSet.includes(PLAYER))).includes(c.vaultSentinel!));
});

// --- 3. Package -------------------------------------------------------------------------------------------------------------

Given("a played game with a package deal in which an NPC promises the player safety and to protect a third houseguest", function (this: BbWorld) {
  const l = game(true, "pkg");
  setEdge(l.g, l.npc, PLAYER, WARM);
  const v = l.s.makeDeal({ with: l.npc, kind: "package", terms: "a bundle", parts: [{ kind: "safety" }, { kind: "protect-third", third: l.others[0] }] } as never) as DealView;
  assert.equal(v?.kind, "package");
  st(this).live = l;
});

Then("the two promises are recorded as separate parts of one package", function (this: BbWorld) {
  const l = st(this).live!;
  const open = l.g.deals.open();
  assert.deepEqual(open.map((d) => d.kind).sort(), ["protect-third", "safety"]);
  assert.equal(new Set(open.map((d) => d.packageId)).size, 1);
  assert.ok(open[0]!.packageId);
});

When("the NPC nominates the protected third houseguest", function (this: BbWorld) {
  const l = st(this).live!;
  l.g.reconcileDeals({ actor: l.npc, kind: "nominate", targets: [l.others[0]] });
});

Then("only the protect-third part is broken and the safety part stays open", function (this: BbWorld) {
  const l = st(this).live!;
  const by = (k: string) => l.g.deals.all.find((d) => d.kind === k)!;
  assert.equal(by("protect-third").status, "broken");
  assert.equal(by("safety").status, "open");
});

Given("two identical promises to spare a houseguest, one of them inside a package", function (this: BbWorld) {
  st(this).packageGain = undefined;
});

When("each promisor nominates the houseguest they promised to spare", function (this: BbWorld) {
  const A = npc(1), B = npc(2);
  const run = (packageId?: string): number => {
    const rel = new RelationshipModel(0.5), ledger = new DealLedger();
    const d = ledger.make([A, B], "target-other", "spare them", undefined, 1);
    if (packageId) d.packageId = packageId;
    const sink: ReconcileSink = { rel, rng: new SeededRandom(7), dealDepth: true, currentWeek: 1 };
    ledger.reconcile({ actor: A, kind: "nominate", targets: [B] }, sink);
    assert.equal(d.status, "broken");
    const e = rel.edge(B, A);
    return e.trust - e.threat - e.affinity * 0.5;
  };
  st(this).packageGain = { packaged: run("pkg:bdd"), plain: run() };
});

Then("the wronged party's read of the packaged breaker falls further than of the stand-alone breaker", function (this: BbWorld) {
  const g = st(this).packageGain!;
  assert.ok(g.packaged < g.plain, `packaged read ${g.packaged} < stand-alone read ${g.plain}`);
});

// --- 4. Weighing a break -----------------------------------------------------------------------------------------------------

function weighSetup(o: { trust: number; affinity: number; threat: number; goal?: boolean; played?: boolean; kind?: Deal["kind"] }): Weigh {
  const sb = new GameSessionRegistry().sandboxFor(`weigh-fixed`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const s = sb.session;
  const g = s as unknown as Internals;
  g.setDealDepthEnabled(true);
  g.live.playedGame = o.played ?? true;
  const n = s.livingIds().find((i) => i !== PLAYER && i !== g.live.hoh)! as EntityId; // ORW-727: the houseguest who weighs the deal holds no crown (the HOH has no vote to offer in its place)
  g.live.hoh ??= s.livingIds().find((i) => i !== PLAYER && i !== n)! as EntityId; g.live.pending = undefined;
  setEdge(g, n, PLAYER, { trust: o.trust, affinity: o.affinity, threat: o.threat });
  g.live.agendas = { [n]: { owner: n, formedForWeek: 1, history: [], goals: o.goal ? [{ id: "g1", owner: n, horizon: "season", kind: "get-them-out", target: PLAYER, why: [], test: { kind: "evicted", who: PLAYER }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 } as never] : [] } } as never;
  const deal = g.deals.make([n, PLAYER], o.kind ?? "safety", "t", undefined, g.live.week);
  return { s, g, npc: n, deal };
}
type Sweep = { broke: number; reneg: number; verdicts: string[] };
/** Re-weigh the same deal across many distinct weeks (each a fresh side-stream roll). */
function sweep(x: Weigh, weeks = 150): Sweep {
  let broke = 0, reneg = 0; const verdicts: string[] = [];
  for (let w = 100; w < 100 + weeks; w++) {
    x.g.live.week = w; x.g.live.dealOffer = undefined;
    x.deal.status = "open"; delete x.deal.sealedBallot; delete x.deal.weighedWeek;
    x.g.weighDealBreaks();
    if ((x.deal.status as string) === "broken") { broke++; verdicts.push("break"); }
    else if (x.g.live.dealOffer) { reneg++; verdicts.push("renegotiate"); }
    else verdicts.push("keep");
  }
  return { broke, reneg, verdicts };
}
const BREAKER = { trust: 0.2, affinity: 0.2, threat: 0.9, goal: true } as const;
const KEEPER = { trust: 0.9, affinity: 0.9, threat: 0.1 } as const;

Given("a played game with an open safety deal an NPC promised the player", function (this: BbWorld) {
  st(this).weigh = weighSetup(BREAKER);
});

When("the NPC weighs the deal on a beat with no ceremony open", function (this: BbWorld) {
  const x = st(this).weigh!;
  x.g.live.week = 300;
  x.g.weighDealBreaks();
});

Then("the deal is marked weighed for this week", function (this: BbWorld) {
  assert.equal(st(this).weigh!.deal.weighedWeek, 300);
});

Then("the same state weighed again gives the same verdicts, because each roll is keyed on the deal and the week", function (this: BbWorld) {
  const a = sweep(weighSetup(BREAKER)).verdicts;
  const b = sweep(weighSetup(BREAKER)).verdicts;
  assert.deepEqual(a, b, "identical verdict sequence from identical state");
  assert.ok(new Set(a).size > 1, "the verdict really varies week to week (a roll, not a constant)");
});

Given("a played game and an NPC with a get-them-out goal on the player, a low bond and little credibility to lose", function (this: BbWorld) {
  st(this).sweeps = undefined;
});
Given("a second NPC with a high bond and a high credibility and no pull", function (this: BbWorld) { /* built in the When: each runs on its own fresh game */ });

When("each weighs an open safety deal with the player once a week", function (this: BbWorld) {
  st(this).sweeps = { breaker: sweep(weighSetup(BREAKER)), keeper: sweep(weighSetup(KEEPER)) };
});

Then("the first sometimes breaks it and the second never does", function (this: BbWorld) {
  const s = st(this).sweeps!;
  assert.ok(s.breaker.broke > 10, `the tempted NPC broke ${s.breaker.broke} of 150 weeks`);
  assert.ok(s.breaker.broke < 150, "but not every week");
  assert.equal(s.keeper.broke, 0);
  assert.equal(s.keeper.reneg, 0);
});

Then("zeroing the temptation stops the breaking, and zeroing the cost makes it more frequent", function (this: BbWorld) {
  const K = DEAL_TEMPTATION as unknown as Record<string, number>;
  const keep = { ...K };
  try {
    const MID = { trust: 0.45, affinity: 0.45, threat: 0.8 };
    const normal = sweep(weighSetup(MID)).broke;
    for (const k of ["threatWeight", "lowBondWeight", "pushWeight", "agendaWeight", "endgameJury", "endgameFinalFive"]) K[k] = 0;
    assert.equal(sweep(weighSetup(BREAKER)).broke, 0, "no temptation, no break");
    Object.assign(K, keep);
    for (const k of ["credibilityWeight", "reliableWeight", "bondWeight", "loyaltyWeight"]) K[k] = 0;
    assert.ok(sweep(weighSetup(MID)).broke > normal, "no price of being known as a liar, more breaks");
  } finally { Object.assign(K, keep); }
});

Given("an NPC that breaks a deal with the player on purpose", function (this: BbWorld) {
  const x = weighSetup(BREAKER);
  const events = x.s.seasonRecap().highlights.length;
  for (let w = 200; (x.deal.status as string) !== "broken" && w < 260; w++) { x.g.live.week = w; delete x.deal.weighedWeek; x.g.weighDealBreaks(); }
  assert.equal(x.deal.status, "broken", "the NPC broke it on purpose");
  const c = st(this); c.weigh = x; c.eventsBefore = events;
});

Then("the deal keeps showing as open to the player and no player-witnessed betrayal is recorded", function (this: BbWorld) {
  const c = st(this); const x = c.weigh!;
  assert.equal(x.deal.sealedBallot, true);
  const view = (x.s.seasonRecap().deals ?? []).find((d) => d.id === x.deal.id)!;
  assert.equal(view.status, "open", "the player still sees the deal as open");
  assert.equal((x.s.getGameState().deals ?? []).find((d) => d.id === x.deal.id)?.status, "open");
  assert.ok(!x.s.seasonRecap().highlights.some((h) => /broke/.test(h)), "no player-witnessed betrayal event");
});

Then("the break and its named terms are recorded Vault-side and never voiced", function (this: BbWorld) {
  const x = st(this).weigh!;
  assert.ok(x.g.live.decisionWhy!.some((w) => w.kind === "deal-break" && w.by === x.npc), "the why is recorded");
  const reason = x.g.live.statedReasons!.find((r) => r.decision === "deal-break")!;
  assert.equal(reason.public, false);
  assert.deepEqual(x.g.statedReasonsFor(x.npc), [], "a quiet break is never voiced");
});

Given("an NPC whose temptation is high but whose margin over the price is not positive, bound by a final-two deal with the player", function (this: BbWorld) {
  const x = weighSetup({ trust: 0.35, affinity: 0.35, threat: 0.9, kind: "final-two" });
  for (let w = 400; w < 600 && !x.g.live.dealOffer; w++) {
    x.g.live.week = w; delete x.deal.weighedWeek; x.g.weighDealBreaks();
    assert.notEqual(x.deal.status, "broken", "a non-positive margin never breaks");
  }
  st(this).weigh = x;
});

Then("it floats a standing offer to swap the deal for a lighter vote promise, carrying the id of the deal it replaces", function (this: BbWorld) {
  const x = st(this).weigh!;
  assert.equal(x.g.live.dealOffer?.replacesDealId, x.deal.id);
  assert.equal(x.g.live.dealOffer?.kind, "vote");
  assert.notEqual(x.s.getGameState().pending?.kind, "deal-offer", "open state, never a pop-up");
});

Then("the old deal stays binding until the player accepts, and accepting retires it neutrally and binds the lighter one", function (this: BbWorld) {
  const x = st(this).weigh!;
  assert.equal(x.deal.status, "open", "still binding until the player answers");
  x.g.resolveDealOffer(true);
  assert.equal(x.deal.status, "lapsed", "retired neutrally: not kept, not broken");
  assert.ok(x.g.deals.open().some((d) => d.kind === "vote" && d.parties.includes(PLAYER)), "the lighter vote promise binds");
});

Given("an open deal already weighed this week", function (this: BbWorld) {
  const x = weighSetup(BREAKER);
  x.g.live.week = 300; x.g.weighDealBreaks();
  assert.equal(x.deal.weighedWeek, 300);
  st(this).weigh = x;
});

Then("it is not rolled again that week", function (this: BbWorld) {
  const x = st(this).weigh!;
  // re-open it as if kept, and weigh again the same week: an un-gated weighing would roll it again (and this NPC breaks most weeks)
  let rolled = 0;
  for (let i = 0; i < 30; i++) {
    x.deal.status = "open"; delete x.deal.sealedBallot; x.g.live.dealOffer = undefined;
    x.g.weighDealBreaks();
    if ((x.deal.status as string) !== "open" || x.g.live.dealOffer) rolled++;
  }
  assert.equal(rolled, 0, "weighed once a week");
  assert.equal(x.deal.weighedWeek, 300);
});

Then("nothing is weighed while a ceremony step is open", function (this: BbWorld) {
  const y = weighSetup(BREAKER);
  y.g.live.pending = { kind: "nominations" };
  y.g.live.week = 301;
  y.g.weighDealBreaks();
  assert.equal(y.deal.weighedWeek, undefined, "not weighed during a ceremony");
  y.g.live.pending = undefined;
  y.g.weighDealBreaks();
  assert.equal(y.deal.weighedWeek, 301, "the same deal is weighed once the ceremony is over");
});

// --- 5. Gating ----------------------------------------------------------------------------------------------------------------

Given("a seeded game nobody is playing, with deal depth on and a tempting open deal with the player", function (this: BbWorld) {
  const l = game(false, "headless");
  const g = l.g;
  g.live.pending = undefined; g.live.hoh ??= l.npc;
  setEdge(g, l.npc, PLAYER, LUKEWARM);
  const [b] = l.others;
  setEdge(g, b!, PLAYER, { trust: 0.2, affinity: 0.2, threat: 0.9 });
  g.deals.make([b!, PLAYER], "safety", "t", undefined, g.live.week);
  g.deals.make([l.npc, PLAYER], "comp-throw", "throw it", undefined, g.live.week);
  g.presence = new Map([[PLAYER, "room:a"], [l.npc, "room:a"], [b!, "room:a"]]);
  st(this).headless = { live: l, before: JSON.stringify(l.s.snapshot()), outs: [] };
});

When("every deal-depth-II entry point is tried", function (this: BbWorld) {
  const h = st(this).headless!; const l = h.live; const g = l.g;
  for (let w = g.live.week; w < g.live.week + 40; w++) { const wk = g.live.week; g.live.week = w; g.weighDealBreaks(); g.live.week = wk; }
  g.bankOwedFavor(l.npc, PLAYER);
  g.deliverInformationDeals();
  h.outs.push(
    l.s.callInFavor(l.npc, "vote"),
    l.s.makeDeal({ with: l.npc, kind: "conditional", terms: "t" } as never),
    l.s.makeDeal({ with: l.npc, kind: "information", terms: "t" } as never),
    l.s.makeDeal({ with: l.npc, kind: "package", terms: "t", parts: [{ kind: "safety" }, { kind: "protect-third", third: l.others[1] }] } as never),
  );
  h.after = JSON.stringify(l.s.snapshot());
  // the ordinary consent read still refuses the too-dear ask (and records its own why, which is not 0142): no counteroffer rides on it
  const ask = askThrow(l) as DealRefusal | null;
  assert.equal(ask?.refused, true);
  h.outs.push(ask?.counteroffer);
});

Then("none of this behavior runs and the engine state is byte-identical", function (this: BbWorld) {
  const h = st(this).headless!;
  assert.deepEqual(h.outs, [null, null, null, null, undefined], "no favor, no new kind, no counteroffer in a game nobody plays");
  assert.equal(h.live.g.live.dealOffer, undefined);
  assert.equal(h.after, h.before, "byte-identical engine state across every 0142 entry point");
});
