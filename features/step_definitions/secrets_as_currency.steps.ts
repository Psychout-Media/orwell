import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../../tests/support/sandbox";
import { learn } from "../support/secretLearn";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { SECRET_TRADE } from "../../src/engine/leverageConstants";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { seasonTrail } from "../support/seasonTrail";
import type { EntityId } from "../../src/domain/ids";
import type { TradeResult } from "../../src/ports/GameSession";

/**
 * Feature 0099 — secrets as a tradeable currency (the 0093 sibling: the TRADE use). Role-only
 * (the-player, a recipient, a rival, an ally, the subject-of-a-secret, the admin). Drives the REAL
 * `GameSessionAdapter.tradeSecret` lever + the `makeDeal` tradedSecret descriptor with the secret-power
 * pathways wired as the composition root wires them. Value is the RECIPIENT's; the engine owns the
 * bounded magnitude (ADR 0005). The Background "a started season…" is shared (0075 confidence.steps).
 */

interface TCState {
  tcSession?: GameSessionAdapter;
  tcSb?: ReturnType<typeof buildSandbox>;
  tcSubject?: EntityId;
  tcRecipient?: EntityId;
  tcFactId?: string;
  tcTrade?: TradeResult;
  tcEdgeBefore?: { trust: number; affinity: number; threat: number };
}
const tc = (w: BbWorld): TCState => w as unknown as TCState;
const relOf = (s: GameSessionAdapter): RelationshipModel => (s as unknown as { rel: RelationshipModel }).rel;
const houseOf = (s: GameSessionAdapter): { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } =>
  (s as unknown as { house: { npcs: Array<{ id: EntityId; character: { hiddenElements?: Array<{ detail: string }> } }> } }).house;

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
  session.createCharacter({ playerName: "The Player", seed });
  return { session, sb };
}

function ensure(w: BbWorld): TCState {
  const st = tc(w);
  if (!st.tcSession) { const { session, sb } = freshSession(110); st.tcSession = session; st.tcSb = sb; }
  return st;
}


const setEdge = (s: GameSessionAdapter, a: EntityId, b: EntityId, v: { trust: number; affinity: number; threat: number }): void => {
  const e = relOf(s).edge(a, b); e.trust = v.trust; e.affinity = v.affinity; e.threat = v.threat;
};

// ── Rule: only a legitimately-held secret can be traded ──────────────────────────────────────────────

Given("a secret the player has no pathway to and has never been told", function (this: BbWorld) {
  const st = ensure(this);
  st.tcSubject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  st.tcRecipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== st.tcSubject)!;
});

When("the player tries to offer that secret to a recipient for a concession", function (this: BbWorld) {
  const st = tc(this);
  st.tcTrade = st.tcSession!.tradeSecret({ factId: "know:never-learned", toNpcId: st.tcRecipient! }) ?? undefined;
});

Then("the trade is rejected", function (this: BbWorld) {
  assert.equal(tc(this).tcTrade!.accepted, false);
  assert.equal(tc(this).tcTrade!.refused, "not-learned");
});

Then("no concession is granted", function (this: BbWorld) {
  assert.equal(tc(this).tcTrade!.accepted, false);
});

Then("the secret never appears on any player-facing surface", function (this: BbWorld) {
  const st = tc(this);
  const sealed = houseOf(st.tcSession!).npcs.find((n) => n.id === st.tcSubject)!.character.hiddenElements?.map((e) => e.detail) ?? [];
  const proj = JSON.stringify(st.tcSession!.getGameState());
  for (const d of sealed) assert.ok(!proj.includes(d));
});

Given("the player only suspects something about a houseguest but has not learned it", function (this: BbWorld) {
  const st = ensure(this);
  st.tcSubject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  st.tcRecipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== st.tcSubject)!;
  st.tcSb!.engine.knowledge.addSuspicion(PLAYER, { content: "a hunch", subject: st.tcSubject, confidence: 0.4 });
  st.tcFactId = st.tcSb!.engine.knowledge.suspicionsOf(PLAYER)[0]!.id;
});

When("the player tries to trade that suspicion to a recipient", function (this: BbWorld) {
  const st = tc(this);
  st.tcTrade = st.tcSession!.tradeSecret({ factId: st.tcFactId!, toNpcId: st.tcRecipient! }) ?? undefined;
});

Then("the trade is rejected because it references no held fact", function (this: BbWorld) {
  assert.equal(tc(this).tcTrade!.accepted, false);
  assert.equal(tc(this).tcTrade!.refused, "not-learned");
});

// ── Rule: a held secret is consideration valued to the recipient ─────────────────────────────────────

Given("the player holds a learned secret about a rival", function (this: BbWorld) {
  const st = ensure(this);
  st.tcSubject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  st.tcFactId = learn(st.tcSb!, st.tcSubject);
});

Given("a recipient who would value leverage on that rival", function (this: BbWorld) {
  const st = tc(this);
  st.tcRecipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== st.tcSubject)!;
  setEdge(st.tcSession!, st.tcRecipient, st.tcSubject!, { trust: 0.1, affinity: 0.05, threat: 0.9 }); // fears the rival
  setEdge(st.tcSession!, st.tcRecipient, PLAYER, { trust: 0.7, affinity: 0.7, threat: 0.05 }); // trusts the player
});

When("the player offers that secret to the recipient in exchange for a deal", function (this: BbWorld) {
  const st = tc(this);
  st.tcTrade = st.tcSession!.tradeSecret({ factId: st.tcFactId!, toNpcId: st.tcRecipient!, askKind: "vote" }) ?? undefined;
});

Then("the engine raises the bounded, seeded likelihood the recipient enters the deal", function (this: BbWorld) {
  // The recipient who VALUES the secret took it (the bounded value pushed them over the bar).
  assert.equal(tc(this).tcTrade!.accepted, true);
});

Then("the recipient learns the traded secret only as a recorded told event with content lineage", function (this: BbWorld) {
  const st = tc(this);
  const fact = st.tcSb!.engine.knowledge.knownTo(st.tcRecipient!).find((k) => k.subject === st.tcSubject);
  assert.ok(fact, "the recipient now holds the traded secret");
  assert.match(fact!.pathway ?? "", /told-by/); // a recorded told pathway (content lineage), not a Vault read
});

Then("the trade and its outcome are recorded as the player's knowledge", function (this: BbWorld) {
  // The player drove it (their own action) — the trade is reflected in the persisted trade count.
  assert.ok((tc(this).tcSession!.snapshot().secretTradeCount ?? 0) >= 1);
});

Then("no number is shown to the player", function (this: BbWorld) {
  assert.doesNotMatch(JSON.stringify(tc(this).tcTrade), /[-+]?\d+\.\d+/);
});

Given("the player holds a learned secret about a houseguest", function (this: BbWorld) {
  const st = ensure(this);
  st.tcSubject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  st.tcFactId = learn(st.tcSb!, st.tcSubject);
});

Given("a recipient who is allied with that houseguest and wants no leverage on them", function (this: BbWorld) {
  const st = tc(this);
  st.tcRecipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== st.tcSubject)!;
  setEdge(st.tcSession!, st.tcRecipient, st.tcSubject!, { trust: 0.8, affinity: 0.9, threat: 0.02 }); // allied with the subject ⇒ secret worthless
  // ...and only coolly disposed to the player, so the near-zero-value secret cannot push them over the bar.
  setEdge(st.tcSession!, st.tcRecipient, PLAYER, { trust: 0.05, affinity: 0.05, threat: 0.5 });
});

When("the player offers that same secret to that recipient for a deal", function (this: BbWorld) {
  const st = tc(this);
  st.tcTrade = st.tcSession!.tradeSecret({ factId: st.tcFactId!, toNpcId: st.tcRecipient!, askKind: "vote" }) ?? undefined;
});

Then("the offered secret moves the deal likelihood almost not at all", function (this: BbWorld) {
  // The secret is worthless to an ally of its subject — its bounded value is near-zero (asserted by the
  // refusal of a lukewarm recipient: nothing pushed them over the bar).
  assert.equal(tc(this).tcTrade!.accepted, false);
});

Then("the recipient may refuse the trade", function (this: BbWorld) {
  assert.equal(tc(this).tcTrade!.accepted, false);
});

Given("the player holds a learned secret a recipient would value", function (this: BbWorld) {
  const st = ensure(this);
  st.tcSubject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  st.tcRecipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== st.tcSubject)!;
  setEdge(st.tcSession!, st.tcRecipient, st.tcSubject, { trust: 0.1, affinity: 0.05, threat: 0.9 });
  st.tcFactId = learn(st.tcSb!, st.tcSubject);
});

Given("the recipient reads the player as a high threat and distrusts them", function (this: BbWorld) {
  const st = tc(this);
  setEdge(st.tcSession!, st.tcRecipient!, PLAYER, { trust: 0.1, affinity: 0.1, threat: 0.9 });
});

When("the player offers the secret for a deal", function (this: BbWorld) {
  const st = tc(this);
  st.tcEdgeBefore = { ...relOf(st.tcSession!).edge(st.tcRecipient!, PLAYER) };
  st.tcTrade = st.tcSession!.tradeSecret({ factId: st.tcFactId!, toNpcId: st.tcRecipient!, askKind: "vote" }) ?? undefined;
});

Then("the recipient can still refuse the trade", function (this: BbWorld) {
  assert.equal(tc(this).tcTrade!.accepted, false);
});

Then("peddling the secret may cost the player standing with that recipient", function (this: BbWorld) {
  // A refused trade sours the recipient's read of the trader (a bounded backlash) — never a number.
  const st = tc(this);
  const after = relOf(st.tcSession!).edge(st.tcRecipient!, PLAYER);
  assert.ok(after.trust < st.tcEdgeBefore!.trust, "peddling a refused secret did not cost any trust with the recipient");
  assert.ok(after.threat > st.tcEdgeBefore!.threat, "...nor raise their wariness");
});

Then("with no secret offered the deal formation is byte-identical to the deal baseline", function () {
  // Two identical seeded houses and the same plain deal: one where the player merely HOLDS a learned secret (never
  // offering it), one where no secret exists at all. The deal and every hidden read come out exactly the same.
  const plain = (holdSecret: boolean): { deals: string; edge: unknown } => {
    const { session, sb } = freshSession(110);
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    const partner = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    if (holdSecret) learn(sb, subject);
    session.makeDeal({ with: partner, kind: "final-two", terms: "no secret here" });
    const deals = JSON.stringify((session.getGameState().deals ?? []).map(({ id: _id, ...d }) => d));
    return { deals, edge: { ...relOf(session).edge(partner, PLAYER) } };
  };
  const held = plain(true);
  const none = plain(false);
  assert.ok(JSON.parse(held.deals).length >= 1, "the plain deal formed as a first-class commitment");
  assert.deepEqual(held, none, "holding an un-offered secret changed how a plain deal forms");
});

// ── Rule: the engine owns the magnitude (anti-sycophancy) ────────────────────────────────────────────

When("the player offers the secret for a concession", function (this: BbWorld) {
  const st = tc(this);
  st.tcTrade = st.tcSession!.tradeSecret({ factId: st.tcFactId!, toNpcId: st.tcRecipient!, askKind: "vote" }) ?? undefined;
});

Then("the magnitude of its effect is bounded and seeded by the engine", function (this: BbWorld) {
  // Try to PUMP it: after the first trade, hand the recipient a fresh learned secret about every other houseguest.
  // Run on two identical seeded houses: the season cap stops the stream, the recipient's warming toward the player is
  // under the configured ceiling, and the SAME seed gives the SAME outcomes (nothing the model sends sets the amount).
  const pump = (): { results: string[]; accepted: number; capped: number; trustGain: number; count: number; subjects: number } => {
    const { session, sb } = freshSession(110);
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    const rec = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    setEdge(session, rec, subject, { trust: 0.1, affinity: 0.05, threat: 0.9 });
    const trustBefore = relOf(session).edge(rec, PLAYER).trust;
    const results: string[] = [];
    const fire = (subj: EntityId): void => {
      const r = session.tradeSecret({ factId: learn(sb, subj), toNpcId: rec, askKind: "vote" });
      results.push(`${r?.accepted}:${r?.refused ?? ""}`);
    };
    fire(subject);
    const others = session.livingIds().filter((id) => id !== PLAYER && id !== rec && id !== subject);
    for (const subj of others) {
      setEdge(session, rec, subj, { trust: 0.1, affinity: 0.05, threat: 0.9 });
      fire(subj);
    }
    return {
      results,
      accepted: results.filter((r) => r.startsWith("true")).length,
      capped: results.filter((r) => r.endsWith(":capped")).length,
      trustGain: relOf(session).edge(rec, PLAYER).trust - trustBefore,
      count: session.snapshot().secretTradeCount ?? 0,
      subjects: others.length + 1,
    };
  };
  const a = pump();
  const b = pump();
  assert.deepEqual(a, b, "the same seed gave a different trade stream (the amount is not seeded)");
  assert.ok(a.subjects > SECRET_TRADE.maxTradesPerSeason, "the fixture offers more trades than the cap");
  assert.ok(a.accepted <= SECRET_TRADE.maxTradesPerSeason, `${a.accepted} trades landed, past the season cap`);
  assert.ok(a.capped > 0, "trades past the cap are refused as capped");
  assert.ok(a.count <= SECRET_TRADE.maxTradesPerSeason, "the recorded trade count passed the season cap");
  // The configured magnitude ceiling: each landed trade warms the recipient by at most the configured fold, scaled by the
  // most generous disposition and jitter band, so the whole stream cannot move them further than cap × that.
  const C = RELATIONSHIP_CONSTANTS;
  const perTradeMax = SECRET_TRADE.recipientFold.trust! * Math.max(...Object.values(C.dispositionFactors).map((d) => d.bondScale)) * (1 + C.TEMPERATURE_JITTER / 2);
  assert.ok(a.trustGain <= SECRET_TRADE.maxTradesPerSeason * perTradeMax + 1e-9, `the recipient warmed ${a.trustGain}, past the configured ceiling`);
});

Then("the model may propose only which secret, to whom, and the ask", function (this: BbWorld) {
  // Sneak extra "magnitude" arguments into the lever: a twin house given the plain request must end up in exactly
  // the same place, so only (factId, toNpcId, askKind) ever reach the engine's decision.
  const run = (extras: Record<string, unknown>): { res: unknown; edge: unknown } => {
    const { session, sb } = freshSession(110);
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    const rec = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
    setEdge(session, rec, subject, { trust: 0.1, affinity: 0.05, threat: 0.9 });
    setEdge(session, rec, PLAYER, { trust: 0.5, affinity: 0.5, threat: 0.2 });
    const res = session.tradeSecret({ factId: learn(sb, subject), toNpcId: rec, askKind: "vote", ...extras } as never);
    return { res, edge: { ...relOf(session).edge(rec, PLAYER) } };
  };
  assert.deepEqual(run({ strength: 1e6, magnitude: 1e6, value: 1e6, tradeValue: 1, dealFactor: 99 }), run({}), "an unknown magnitude argument moved the outcome");
});

Then("the model cannot inflate how far the trade moves the recipient", function (this: BbWorld) {
  // No number crosses; the engine owns the amount (the result has no magnitude).
  assert.doesNotMatch(JSON.stringify(tc(this).tcTrade), /[-+]?\d+\.\d+/);
});

// ── Rule: the Vault Wall holds for player AND admin ─────────────────────────────────────────────────

Given("the player has traded a secret and houseguests have bartered secrets off-screen", function (this: BbWorld) {
  const st = ensure(this);
  const subject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  const recipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== subject)!;
  setEdge(st.tcSession!, recipient, subject, { trust: 0.1, affinity: 0.05, threat: 0.9 });
  setEdge(st.tcSession!, recipient, PLAYER, { trust: 0.7, affinity: 0.7, threat: 0.05 });
  st.tcSubject = subject; st.tcRecipient = recipient;
  st.tcFactId = learn(st.tcSb!, subject);
  st.tcSession!.tradeSecret({ factId: st.tcFactId, toNpcId: recipient, askKind: "vote" });
});

When("the player-facing and admin-facing projections are assembled", function () { /* read in the Then */ });

Then("no trade value or hidden standing change appears on either surface", function (this: BbWorld) {
  const st = tc(this);
  const playerProj = JSON.stringify(st.tcSession!.getGameState()) + JSON.stringify(st.tcSession!.gameStatus());
  const adminProj = JSON.stringify(st.tcSb!.admin.inspect());
  for (const n of [SECRET_TRADE.dealFactorCap, SECRET_TRADE.recipientFold.trust!]) {
    assert.ok(!playerProj.includes(String(n)) && !adminProj.includes(String(n)));
  }
  assert.ok(!adminProj.match(/tradeValue|recipientFold/));
});

Then("no off-screen bartered secret the player has no pathway to appears on either surface", function (this: BbWorld) {
  // The player-facing projection carries only the player's OWN knowledge — no NPC↔NPC hidden barter.
  const st = tc(this);
  const proj = JSON.stringify(st.tcSession!.getGameState());
  assert.doesNotMatch(proj, /barter|tradeValue/);
});

Then("both surfaces show only the fact of a trade the player is party to and observable fallout", function (this: BbWorld) {
  // The trade was the player's own action (counted), and the recipient's new knowledge is observable —
  // but no magnitude crosses (the no-number checks above hold).
  assert.ok((tc(this).tcSession!.snapshot().secretTradeCount ?? 0) >= 1);
});

// ── Rule: trades are deterministic and a traded secret persists ─────────────────────────────────────

Given("a fixed seed and history with a held secret offered to a recipient", function (this: BbWorld) {
  const st = tc(this);
  const a = freshSession(321); const b = freshSession(321);
  const subjA = a.session.livingIds().find((id) => id !== PLAYER)!;
  const recA = a.session.livingIds().find((id) => id !== PLAYER && id !== subjA)!;
  const subjB = b.session.livingIds().find((id) => id !== PLAYER)!;
  const recB = b.session.livingIds().find((id) => id !== PLAYER && id !== subjB)!;
  for (const [s, subj, rec] of [[a.session, subjA, recA], [b.session, subjB, recB]] as const) {
    setEdge(s, rec, subj, { trust: 0.1, affinity: 0.05, threat: 0.9 });
    setEdge(s, rec, PLAYER, { trust: 0.7, affinity: 0.7, threat: 0.05 });
  }
  const fA = learn(a.sb, subjA); const fB = learn(b.sb, subjB);
  Object.assign(st as object, { tcA: a.session, tcB: b.session, tcSubjA: subjA, tcSubjB: subjB, tcRecA: recA, tcRecB: recB, tcFA: fA, tcFB: fB });
});

When("the trade is resolved twice from the same state", function (this: BbWorld) {
  const st = this as unknown as { tcA: GameSessionAdapter; tcB: GameSessionAdapter; tcRecA: EntityId; tcRecB: EntityId; tcFA: string; tcFB: string; tcResA?: TradeResult; tcResB?: TradeResult };
  st.tcResA = st.tcA.tradeSecret({ factId: st.tcFA, toNpcId: st.tcRecA, askKind: "vote" }) as TradeResult;
  st.tcResB = st.tcB.tradeSecret({ factId: st.tcFB, toNpcId: st.tcRecB, askKind: "vote" }) as TradeResult;
});

Then("the trade value, the outcome, and the folds are identical both times", function (this: BbWorld) {
  const st = this as unknown as { tcA: GameSessionAdapter; tcB: GameSessionAdapter; tcRecA: EntityId; tcRecB: EntityId; tcResA: TradeResult; tcResB: TradeResult };
  assert.deepEqual(st.tcResA, st.tcResB);
  assert.deepEqual(relOf(st.tcA).edge(st.tcRecA, PLAYER), relOf(st.tcB).edge(st.tcRecB, PLAYER));
});

Given("a full season is played with no secret traded and off-screen barter disabled", function (this: BbWorld) {
  // A season in which the player merely HOLDS learned secrets (never trading one) vs a season with none learned.
  const play = (hold: boolean): string => {
    const { session, sb } = freshSession(505);
    if (hold) for (const id of session.livingIds().filter((i) => i !== PLAYER).slice(0, 3)) learn(sb, id);
    return seasonTrail(session);
  };
  (this as unknown as { tcSeasons: [string, string] }).tcSeasons = [play(true), play(false)];
});

Then("the seeded vote and eviction outcomes are byte-identical to the baseline season", function (this: BbWorld) {
  const [held, baseline] = (this as unknown as { tcSeasons: [string, string] }).tcSeasons;
  assert.ok(held.length > 40, "a season was actually played");
  assert.equal(held, baseline, "holding secrets (without trading) moved the seeded outcomes");
});

Given("the player has traded a held secret to a recipient", function (this: BbWorld) {
  const st = ensure(this);
  const subject = st.tcSession!.livingIds().find((id) => id !== PLAYER)!;
  const recipient = st.tcSession!.livingIds().find((id) => id !== PLAYER && id !== subject)!;
  setEdge(st.tcSession!, recipient, subject, { trust: 0.1, affinity: 0.05, threat: 0.9 });
  setEdge(st.tcSession!, recipient, PLAYER, { trust: 0.7, affinity: 0.7, threat: 0.05 });
  st.tcSubject = subject; st.tcRecipient = recipient;
  st.tcFactId = learn(st.tcSb!, subject);
  const r = st.tcSession!.tradeSecret({ factId: st.tcFactId, toNpcId: recipient, askKind: "vote" }) as TradeResult;
  assert.equal(r.accepted, true);
  // Bind the trajectories-shared `twSession`/`twSnap` so the SHARED "the game is saved and restored"
  // step (trajectories.steps) snapshots OUR session — our Thens restore from that twSnap.
  (this as unknown as { twSession?: GameSessionAdapter }).twSession = st.tcSession;
});

// NOTE: "the game is saved and restored" reuses the SHARED trajectories.steps definition (it snapshots
// `twSession` into `twSnap`, which our Given binds to our session); we do NOT redefine it (globally-unique).

/** Restore OUR session from the trajectories-shared snapshot the shared When produced. */
function restoredFromShared(w: BbWorld): GameSessionAdapter {
  const st = tc(w);
  const core = (w as unknown as { twSnap?: import("../../src/engine/sessionSnapshot").SessionSnapshot }).twSnap!;
  const restored = new GameSessionAdapter();
  restored.setPlayerKnowledgeReader(() => st.tcSb!.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })));
  restored.restore(core);
  st.tcSession = restored;
  return restored;
}

Then("the secret is still marked as used", function (this: BbWorld) {
  const restored = restoredFromShared(this);
  assert.equal(restored.snapshot().secretUsedAs?.[tc(this).tcFactId!], "traded");
});

Then("the recipient still holds the traded secret", function (this: BbWorld) {
  const st = tc(this);
  // The recipient's knowledge lives in the persistent engine sandbox (the pathway recorded it there).
  assert.ok(st.tcSb!.engine.knowledge.knownTo(st.tcRecipient!).some((k) => k.subject === st.tcSubject));
});

Then("the per-season trade count is unchanged by the restart", function (this: BbWorld) {
  assert.equal(tc(this).tcSession!.snapshot().secretTradeCount, 1);
});

// ── Rule: NPCs barter secrets with each other, hidden (the off-screen half) ──────────────────────────
// The NPC↔NPC barter is the hidden 0099 half. For this build's vertical slice it rides the existing
// 0038/0094 diffusion substrate; these steps assert the Vault-safety invariant (no NPC↔NPC fact reaches
// the player without a pathway), which holds by construction (the player learns only via knownTo pathways).

Given("a houseguest who holds a juicy secret about a rival", function (this: BbWorld) {
  const st = ensure(this);
  const npcs = st.tcSession!.livingIds().filter((id) => id !== PLAYER);
  st.tcSubject = npcs[0]!; // the rival
  st.tcRecipient = npcs[1]!; // the holder/ally
  // Seed the holder with the secret in the HIDDEN layer only (NPC↔NPC; the player has no pathway).
  st.tcSb!.engine.knowledge.seedBelief(st.tcRecipient, { content: `npc-held secret about ${st.tcSubject}`, originalContent: "x", factId: `npc:${st.tcSubject}`, confidence: 0.8, hops: 0, distortion: 0, source: st.tcRecipient }, "origin");
});

Given("an ally of that houseguest who would value it", function (this: BbWorld) {
  const st = tc(this);
  const npcs = st.tcSession!.livingIds().filter((id) => id !== PLAYER && id !== st.tcSubject && id !== st.tcRecipient);
  (st as unknown as { tcAlly?: EntityId }).tcAlly = npcs[0]!;
});

When("the holder barters the secret to the ally off-screen to firm their bond", function (this: BbWorld) {
  const st = tc(this) as unknown as { tcSb: ReturnType<typeof buildSandbox>; tcRecipient: EntityId; tcAlly: EntityId; tcSubject: EntityId };
  // The barter transfers the fact NPC↔NPC in the HIDDEN layer (gossip transmit) — never to the player.
  st.tcSb.engine.knowledge.transmitGossip(st.tcRecipient, st.tcAlly, { content: `npc-held secret about ${st.tcSubject}`, factId: `npc:${st.tcSubject}`, source: st.tcRecipient }, `told-by:${st.tcRecipient}`);
});

Then("the trade and its price are recorded only in the hidden layer", function (this: BbWorld) {
  // The player has NO knowledge of the NPC↔NPC barter (no pathway terminated at them).
  const st = tc(this);
  assert.ok(!st.tcSb!.engine.knowledge.knownTo(PLAYER).some((k) => (k.factId ?? "").startsWith("npc:")));
});

Then("the ally now holds the secret in the hidden layer", function (this: BbWorld) {
  const st = tc(this) as unknown as { tcSb: ReturnType<typeof buildSandbox>; tcAlly: EntityId };
  assert.ok(st.tcSb.engine.knowledge.knownTo(st.tcAlly).some((k) => (k.factId ?? "").startsWith("npc:")));
});

Then("the player learns of the barter only if a pathway later reaches them", function (this: BbWorld) {
  // Still no pathway to the player ⇒ they don't know it (the structural guarantee).
  const st = tc(this);
  assert.ok(!st.tcSb!.engine.knowledge.knownTo(PLAYER).some((k) => (k.factId ?? "").startsWith("npc:")));
});

Then("the bartered secret never appears on any player-facing surface without a pathway", function (this: BbWorld) {
  const st = tc(this);
  const proj = JSON.stringify(st.tcSession!.getGameState()) + JSON.stringify(st.tcSession!.npcVoice(st.tcRecipient!));
  assert.ok(!proj.includes("npc-held secret"));
});
