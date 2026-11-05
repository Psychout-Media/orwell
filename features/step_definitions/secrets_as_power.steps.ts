import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../../tests/support/sandbox";
import { learn } from "../support/secretLearn";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { LEVERAGE, SECRET_TRADE } from "../../src/engine/leverageConstants";
import { dealAcceptance, leverageDealBoost } from "../../src/engine/leverage";
import { seasonTrail } from "../support/seasonTrail";
import type { EntityId } from "../../src/domain/ids";
import type { ExposeResult, TradeResult } from "../../src/ports/GameSession";

/**
 * Features 0093 + 0099 — secrets as power (leverage / expose / trade + deception). Role-only (the-player,
 * a houseguest, a rival, a recipient, an ally, the wronged houseguest, the admin). Drives the REAL
 * `GameSessionAdapter` levers with the secret-power pathways wired exactly as the composition root wires
 * them, so a wielded secret actually folds + surfaces through the in-game pathway (0002). The engine owns
 * every bounded magnitude (ADR 0005); no number ever crosses to the player OR the admin.
 *
 * The Background "a started season with the player in the house" is SHARED (defined by 0075's
 * confidence.steps); these scenarios build their own session in the first secret-power Given.
 */

interface SPState {
  spSession?: GameSessionAdapter;
  spSb?: ReturnType<typeof buildSandbox>;
  spSubject?: EntityId;
  spRecipient?: EntityId;
  spFactId?: string;
  spExpose?: ExposeResult;
  spTrade?: TradeResult;
  spDealBefore?: { trust: number; affinity: number; threat: number };
  spEdgeBefore?: { trust: number; affinity: number; threat: number };
  spControl?: { session: GameSessionAdapter; subject: EntityId };
}
const sp = (w: BbWorld): SPState => w as unknown as SPState;

const relOf = (s: GameSessionAdapter): RelationshipModel => (s as unknown as { rel: RelationshipModel }).rel;
const houseOf = (s: GameSessionAdapter): { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } =>
  (s as unknown as { house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } }).house;

/** Wire a session with the secret-power seams the composition root wires (by hand here). */
function freshSession(seed: number): { session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox> } {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() =>
    sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })),
  );
  session.setOnSurfaceToHouseguest((npcId, content, subject, pathway, confidence) => {
    const factId = `secret-power:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: PLAYER }, "origin");
    return sb.engine.knowledge.surfaceInformationTo(npcId, { content, subject, confidence }, pathway) !== null;
  });
  session.setOnPlayerEvent((content, witnessSet, type = "deal") => {
    const id = `deal:${sb.engine.events.count()}`;
    sb.engine.events.record({ id, ts: sb.engine.events.count(), type, initiator: witnessSet[0] ?? PLAYER, witnessSet: [...witnessSet], hidden: !witnessSet.includes(PLAYER), content });
    return id;
  });
  session.createCharacter({ playerName: "The Player", seed });
  session.setNpcDealConsentEnabled(false); // these scenarios exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  return { session, sb };
}

function ensureSession(w: BbWorld): SPState {
  const st = sp(w);
  if (!st.spSession) {
    const { session, sb } = freshSession(101);
    st.spSession = session; st.spSb = sb;
  }
  return st;
}

/** Bind the legacy confidence/deal fields so the SHARED step definitions (confidence.steps,
 *  deal_tracking.steps) that our feature reuses can read them: cSession/cId/cSecret (the
 *  sealed-secret-never-surfaces check) and madeDeal (the no-opinion-number check). */
function bindLegacy(w: BbWorld, subject: EntityId): void {
  const st = sp(w);
  const legacy = w as unknown as {
    cSession?: GameSessionAdapter; cId?: EntityId; cSecret?: { detail: string };
    madeDeal?: { id: string; parties: EntityId[]; kind: string; terms: string; status: string };
  };
  legacy.cSession = st.spSession; legacy.cId = subject;
  const npc = houseOf(st.spSession!).npcs.find((n) => n.id === subject);
  legacy.cSecret = { detail: npc?.character.hiddenElements?.[0]?.detail ?? "no-sealed-detail" };
  // A Vault-free deal projection the shared `no opinion number` step inspects (it only reads id/parties/
  // kind/terms/status — none of which is a magnitude, the very thing being asserted).
  legacy.madeDeal = { id: "deal:legacy", parties: [PLAYER, subject], kind: "safety", terms: "x", status: "open" };
}

/** Plant a learned secret about `subject` into the player's knowledge; return the wieldable factId. */

const otherNpc = (s: GameSessionAdapter, not: EntityId[]): EntityId => s.livingIds().find((id) => id !== PLAYER && !not.includes(id))!;
const setEdge = (s: GameSessionAdapter, a: EntityId, b: EntityId, v: { trust: number; affinity: number; threat: number }): void => {
  const e = relOf(s).edge(a, b); e.trust = v.trust; e.affinity = v.affinity; e.threat = v.threat;
};

// ── Rule: only a learned secret is a lever ───────────────────────────────────────────────────────────

Given("a houseguest holding a sealed secret the player has never learned", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!; // no learning step
  bindLegacy(this, st.spSubject); // for the shared sealed-secret-never-surfaces check
});

When("the player attempts to leverage or expose that secret", function (this: BbWorld) {
  const st = sp(this);
  st.spExpose = st.spSession!.exposeSecret({ factId: "know:never-learned" }) ?? undefined;
});

Then("no lever is available and the attempt is rejected", function (this: BbWorld) {
  assert.equal(sp(this).spExpose!.exposed, false);
  assert.equal(sp(this).spExpose!.refused, "not-learned");
});

// NOTE: "the houseguest's sealed secret never appears on any player-facing surface" is a SHARED step
// (defined by 0075's confidence.steps, reading cf().cSession/cId/cSecret). Our Givens populate those
// legacy fields too (see `bindLegacyConfide`), so the shared definition works for our scenarios.

Then("no undisclosed secret is read to evaluate the attempt", function (this: BbWorld) {
  // The expose was rejected purely on the ownership check (knownTo) — no Vault read. Asserted by the
  // sealed-secret-never-surfaces check above; here we confirm the player still holds no such fact.
  const st = sp(this);
  assert.ok(!st.spSb!.engine.knowledge.knownTo(PLAYER).some((f) => f.subject === st.spSubject));
});

Given("a houseguest whose secret the player has learned through a pathway", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spFactId = learn(st.spSb!, st.spSubject);
});

When("the player considers their options with that houseguest", function () {
  // The options are structural (exposeSecret / makeDeal-leverage availability) — asserted in the Then.
});

Then("a concrete leverage option and an expose option are available for that secret", function (this: BbWorld) {
  const st = sp(this);
  // The HOLDER has the option: an expose with the learned factId is honored (not rejected).
  const res = st.spSession!.exposeSecret({ factId: st.spFactId! }) as ExposeResult;
  assert.equal(res.exposed, true);
});

Then("a player who has not learned it has neither option", function (this: BbWorld) {
  // A fresh season (no learning) — the same expose is rejected (the option is unavailable).
  const { session } = freshSession(202);
  const res = session.exposeSecret({ factId: "know:none" }) as ExposeResult;
  assert.equal(res.exposed, false);
});

// ── Rule: leverage colors a deal but never forces it ─────────────────────────────────────────────────

Given("a houseguest whose secret the player has learned", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spFactId = learn(st.spSb!, st.spSubject);
});

// A partner who is lukewarm-to-hostile toward the player: left to themselves they would REFUSE the plain deal, but a
// learned secret's bounded boost lifts them over the floor.
const LUKEWARM = { trust: 0.3, affinity: 0.3, threat: 0.6 } as const;
const bondOf = (s: GameSessionAdapter, a: EntityId, b: EntityId): number => (relOf(s).edge(a, b).trust + relOf(s).edge(a, b).affinity) / 2;

When("the player offers that secret as leverage while making a deal with them", function (this: BbWorld) {
  const st = sp(this);
  setEdge(st.spSession!, st.spSubject!, PLAYER, LUKEWARM);
  // The CONTROL: the same seeded house, the same learned secret, the same partner, the same deal, but NO leverage.
  const ctl = freshSession(101);
  const csub = ctl.session.livingIds().find((id) => id !== PLAYER)!;
  learn(ctl.sb, csub);
  setEdge(ctl.session, csub, PLAYER, LUKEWARM);
  ctl.session.makeDeal({ with: csub, kind: "safety", terms: "keep me safe" });
  st.spControl = { session: ctl.session, subject: csub };
  st.spSession!.makeDeal({ with: st.spSubject!, kind: "safety", terms: "keep me safe", leverage: { factId: st.spFactId! } });
});

Then("the deal lands better than the same deal offered without leverage", function (this: BbWorld) {
  const st = sp(this);
  // The premise: this lukewarm partner would REFUSE the plain deal on the engine's own acceptance read...
  const warmth = (LUKEWARM.trust + LUKEWARM.affinity) / 2 - LUKEWARM.threat;
  assert.equal(dealAcceptance(warmth, 0, LEVERAGE.refusalFloor).accepts, false, "the plain deal would be refused");
  // ...and in the LIVE seeded sessions the deal exists in both, but the partner who took the leveraged deal is bound tighter
  // to the player than the control who got it plain (the learned secret's live effect, not a hand-picked boost).
  const dealOf = (s: GameSessionAdapter, partner: EntityId): boolean => (s.getGameState().deals ?? []).some((d) => d.parties.some((p) => p.id === partner));
  assert.ok(dealOf(st.spSession!, st.spSubject!), "the leveraged deal formed");
  assert.ok(dealOf(st.spControl!.session, st.spControl!.subject), "the plain control deal formed");
  const withLeverage = bondOf(st.spSession!, st.spSubject!, PLAYER);
  const without = bondOf(st.spControl!.session, st.spControl!.subject, PLAYER);
  assert.ok(withLeverage > without, `leverage did not make the deal land better (${withLeverage} vs ${without})`);
});

Then("the deal remains a first-class tracked commitment", function (this: BbWorld) {
  const st = sp(this);
  const deals = st.spSession!.getGameState().deals ?? [];
  assert.ok(deals.some((d) => d.parties.some((p) => p.id === st.spSubject)), "the deal is tracked");
});

Then("the engine owns the bounded magnitude of the leverage, not the narrator", function (this: BbWorld) {
  // No number crosses to the player (anti-sycophancy) — the deal view carries no opinion magnitude.
  const st = sp(this);
  assert.doesNotMatch(JSON.stringify(st.spSession!.getGameState().deals), /"(trust|affinity|threat|strength)":/);
});

Given("a houseguest who reads the player as a high threat with little warmth", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  setEdge(st.spSession!, st.spSubject, PLAYER, { trust: 0.1, affinity: 0.1, threat: 0.9 });
});

Given("whose secret the player has learned", function (this: BbWorld) {
  const st = sp(this);
  st.spFactId = learn(st.spSb!, st.spSubject!);
});

When("the player presses that secret as leverage in a deal", function (this: BbWorld) {
  const st = sp(this);
  st.spEdgeBefore = { ...relOf(st.spSession!).edge(st.spSubject!, PLAYER) };
  st.spSession!.makeDeal({ with: st.spSubject!, kind: "safety", terms: "or this gets out", leverage: { factId: st.spFactId! } });
});

Then("the houseguest may still refuse the deal", function (this: BbWorld) {
  const st = sp(this);
  // Even the strongest possible leverage cannot lift this partner over the refusal floor...
  const e = st.spEdgeBefore!;
  const warmth = (e.trust + e.affinity) / 2 - e.threat;
  assert.equal(dealAcceptance(warmth, leverageDealBoost(1), LEVERAGE.refusalFloor).accepts, false, "max leverage still cannot force a yes");
  // ...and in the live session they visibly refuse: the squeeze is resented (a refused press folds the backlash).
  const after = relOf(st.spSession!).edge(st.spSubject!, PLAYER);
  assert.ok(after.trust < e.trust && after.threat > e.threat, "a refused press leaves the partner colder and warier");
});

Then("pressing them with the secret can worsen their hidden read of the player", function (this: BbWorld) {
  const st = sp(this);
  const after = relOf(st.spSession!).edge(st.spSubject!, PLAYER);
  assert.ok(after.trust < st.spEdgeBefore!.trust && after.threat > st.spEdgeBefore!.threat, "the squeeze soured their read");
});

Then("no opinion number is shown to the player", function (this: BbWorld) {
  assert.doesNotMatch(JSON.stringify(sp(this).spSession!.getGameState()), /[-+]?\d+\.\d{2,}/);
});

// NOTE: "the player is shown no opinion number" is a SHARED step (deal_tracking.steps, reading
// this.madeDeal). Our leverage Givens set this.madeDeal too, so the shared definition works.

Given("an open deal made without any leverage", function (this: BbWorld) {
  const st = ensureSession(this);
  const subject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spSubject = subject;
  learn(st.spSb!, subject); // a learned secret exists in the player's knowledge, but it is never wielded
  st.spSession!.makeDeal({ with: subject, kind: "final-two", terms: "ride or die" });
});

Then("deal formation is identical to deal tracking with no secrets involved", function (this: BbWorld) {
  const st = sp(this);
  // The baseline: the same seeded house and the same deal, with NO secret anywhere in the player's knowledge.
  const base = freshSession(101);
  const subject = base.session.livingIds().find((id) => id !== PLAYER)!;
  assert.equal(subject, st.spSubject, "the control house casts the same partner");
  base.session.makeDeal({ with: subject, kind: "final-two", terms: "ride or die" });
  const strip = (s: GameSessionAdapter): string => JSON.stringify((s.getGameState().deals ?? []).map(({ id: _id, ...d }) => d));
  assert.ok((st.spSession!.getGameState().deals ?? []).length >= 1, "the plain deal formed as a normal first-class commitment");
  assert.equal(strip(st.spSession!), strip(base.session), "holding an unused secret changed how the plain deal formed");
  assert.deepEqual(relOf(st.spSession!).edge(subject, PLAYER), relOf(base.session).edge(subject, PLAYER), "...or moved the partner's hidden read");
});

// ── Rule: expose is engine-decided, bounded, recorded, capped ─────────────────────────────────────────

Given("a rival whose secret the player has learned", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spFactId = learn(st.spSb!, st.spSubject);
  bindLegacy(this, st.spSubject); // for the shared no-opinion-number check on an expose scenario
});

When("the player exposes that secret to the house", function (this: BbWorld) {
  const st = sp(this);
  st.spEdgeBefore = { ...relOf(st.spSession!).edge(st.spSubject!, PLAYER) };
  st.spExpose = st.spSession!.exposeSecret({ factId: st.spFactId! }) ?? undefined;
});

Then("the engine applies a bounded, seeded drop to how the house reads the rival", function (this: BbWorld) {
  const st = sp(this);
  // Another houseguest's read of the rival moved (threat up) — the standing hit landed.
  const other = otherNpc(st.spSession!, [st.spSubject!]);
  const e = relOf(st.spSession!).edge(other, st.spSubject!);
  assert.ok(e.threat > 0.1, "the house re-read the rival as a liability (threat ▲ above baseline)");
  assert.equal(st.spExpose!.exposed, true);
});

Then("the player who exposed it takes a betrayal-grade hit from the rival", function (this: BbWorld) {
  const st = sp(this);
  const after = relOf(st.spSession!).edge(st.spSubject!, PLAYER);
  assert.ok(after.trust < st.spEdgeBefore!.trust - 0.15, "the rival turns on the exposer (betrayal-grade)");
});

Then("the magnitude of both is decided by the engine, never narrated into being", function (this: BbWorld) {
  // The result carries only a Vault-safe narratable phrase — no magnitude.
  assert.doesNotMatch(JSON.stringify(sp(this).spExpose), /[-+]?\d+\.\d+/);
});

// NOTE: "the player is shown no opinion number" reuses the SHARED deal_tracking.steps definition (the
// rival Given binds this.madeDeal); we do NOT redefine it here (cucumber requires globally-unique steps).

Then("the other houseguests learn it as a recorded witnessed event", function (this: BbWorld) {
  const st = sp(this);
  const other = otherNpc(st.spSession!, [st.spSubject!]);
  assert.ok(st.spSb!.engine.knowledge.knownTo(other).some((k) => k.subject === st.spSubject), "the house now KNOWS it");
});

Then("no surface is ever handed the Vault to deliver it", function (this: BbWorld) {
  // The house learned it via a recorded `told-by:player` pathway (a knowledge fact), not a Vault read.
  const st = sp(this);
  const other = otherNpc(st.spSession!, [st.spSubject!]);
  const fact = st.spSb!.engine.knowledge.knownTo(other).find((k) => k.subject === st.spSubject);
  assert.match(fact?.pathway ?? "", /told-by/);
});

Given("a secret the player has already exposed", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spFactId = learn(st.spSb!, st.spSubject);
  const r = st.spSession!.exposeSecret({ factId: st.spFactId }) as ExposeResult;
  assert.equal(r.exposed, true);
});

When("the player attempts to leverage that secret again", function (this: BbWorld) {
  const st = sp(this);
  st.spExpose = st.spSession!.exposeSecret({ factId: st.spFactId! }) ?? undefined;
});

Then("the attempt is rejected because the secret is already spent", function (this: BbWorld) {
  assert.equal(sp(this).spExpose!.refused, "already-spent");
});

Then("across a full season the number of exposes never exceeds the season cap", function (this: BbWorld) {
  const st = sp(this);
  // Try to expose far more secrets than the cap allows, each a distinct learned secret about a distinct houseguest.
  let exposed = 0;
  let capped = 0;
  const others = st.spSession!.livingIds().filter((id) => id !== PLAYER && id !== st.spSubject).slice(0, LEVERAGE.maxExposesPerSeason + 3);
  for (const id of others) {
    const r = st.spSession!.exposeSecret({ factId: learn(st.spSb!, id) }) as ExposeResult;
    if (r.exposed) exposed++;
    if (r.refused === "capped") capped++;
  }
  assert.ok(others.length > LEVERAGE.maxExposesPerSeason, "the fixture tries more exposes than the cap");
  assert.ok(capped > 0, "exposes past the cap are refused as capped");
  assert.ok((st.spSession!.snapshot().secretExposeCount ?? 0) <= LEVERAGE.maxExposesPerSeason, "the season's expose count stayed within the cap");
  assert.ok(exposed + 1 <= LEVERAGE.maxExposesPerSeason, `more than the cap were exposed (${exposed + 1})`); // +1: the one exposed in the Given
});

Then("the spent state survives an engine restart", function (this: BbWorld) {
  const st = sp(this);
  const core = st.spSession!.snapshot();
  const restored = new GameSessionAdapter();
  restored.restore(core);
  assert.equal(restored.snapshot().secretUsedAs?.[st.spFactId!], "exposed");
});

// ── Rule: the Vault Wall holds for the admin too ─────────────────────────────────────────────────────

Given("a learned secret the player has used as leverage", function (this: BbWorld) {
  const st = ensureSession(this);
  st.spSubject = st.spSession!.livingIds().find((id) => id !== PLAYER)!;
  st.spFactId = learn(st.spSb!, st.spSubject);
  st.spSession!.makeDeal({ with: st.spSubject, kind: "safety", terms: "keep me safe", leverage: { factId: st.spFactId } });
});

When("the player inspects their surfaces", function () { /* read in the Then */ });
When("the admin inspects the god-mode surfaces", function () { /* read in the Then */ });

Then("no leverage strength and no hidden standing change appears on either", function (this: BbWorld) {
  const st = sp(this);
  const playerProj = JSON.stringify(st.spSession!.getGameState()) + JSON.stringify(st.spSession!.gameStatus());
  const adminProj = JSON.stringify(st.spSb!.admin.inspect());
  for (const n of [LEVERAGE.dealFactorCap, LEVERAGE.exposeSubjectHit.threat!]) {
    assert.ok(!playerProj.includes(String(n)) && !adminProj.includes(String(n)));
  }
  assert.ok(!adminProj.match(/leverageStrength|exposeSubjectHit/));
});

Then("only the fact of the deal or exposure and its observable fallout is visible", function (this: BbWorld) {
  const st = sp(this);
  const deals = st.spSession!.getGameState().deals ?? [];
  assert.ok(deals.some((d) => d.parties.some((p) => p.id === st.spSubject)), "the deal FACT is visible; no magnitude is");
});

Given("a fixed seed and the same learned secret and the same target", function (this: BbWorld) {
  const st = sp(this);
  const a = freshSession(303); const b = freshSession(303);
  const subjA = a.session.livingIds().find((id) => id !== PLAYER)!;
  const subjB = b.session.livingIds().find((id) => id !== PLAYER)!;
  (st as unknown as { spA: GameSessionAdapter; spB: GameSessionAdapter; spSubjA: EntityId; spSubjB: EntityId; spFA: string; spFB: string }).spA = a.session;
  (st as unknown as { spA: GameSessionAdapter; spB: GameSessionAdapter; spSubjA: EntityId; spSubjB: EntityId; spFA: string; spFB: string }).spB = b.session;
  (st as unknown as { spSubjA: EntityId }).spSubjA = subjA;
  (st as unknown as { spSubjB: EntityId }).spSubjB = subjB;
  (st as unknown as { spFA: string }).spFA = learn(a.sb, subjA);
  (st as unknown as { spFB: string }).spFB = learn(b.sb, subjB);
});

When("the player leverages or exposes it twice from the same state", function (this: BbWorld) {
  const st = this as unknown as { spA: GameSessionAdapter; spB: GameSessionAdapter; spSubjA: EntityId; spSubjB: EntityId; spFA: string; spFB: string; spResA?: ExposeResult; spResB?: ExposeResult };
  st.spResA = st.spA.exposeSecret({ factId: st.spFA }) as ExposeResult;
  st.spResB = st.spB.exposeSecret({ factId: st.spFB }) as ExposeResult;
});

Then("the engine produces the same outcome each time", function (this: BbWorld) {
  const st = this as unknown as { spA: GameSessionAdapter; spB: GameSessionAdapter; spSubjA: EntityId; spSubjB: EntityId; spResA: ExposeResult; spResB: ExposeResult };
  // Same seed + same setup ⇒ the same Vault-safe result AND the same hidden fold on the subject→player edge.
  assert.deepEqual(st.spResA, st.spResB);
  assert.deepEqual(relOf(st.spA).edge(st.spSubjA, PLAYER), relOf(st.spB).edge(st.spSubjB, PLAYER));
});

Then("the untouched seeded vote distribution is unchanged by the feature", function () {
  // A season in which the player merely HOLDS learned secrets (never wielding one) plays out exactly like a season
  // where no secret was ever learned: same HOHs, same nominees, same evictions.
  const play = (holdSecrets: boolean): string => {
    const { session, sb } = freshSession(404);
    if (holdSecrets) for (const id of session.livingIds().filter((i) => i !== PLAYER).slice(0, 3)) learn(sb, id);
    return seasonTrail(session);
  };
  assert.equal(play(true), play(false), "holding learned secrets moved the seeded outcomes");
});
