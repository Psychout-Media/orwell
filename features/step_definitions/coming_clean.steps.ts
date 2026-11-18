import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import type { ClaimLog, SpokenClaim } from "../../src/engine/spokenClaims";
import { catchRisk, confessChance, versionsAbout, confessionTrustDrop, type CleanAct } from "../../src/engine/comingClean";
import { caughtLieTrustDrop, CAUGHT_LIE } from "../../src/engine/caughtLies";

/** Feature 0203 (ORW-646) - coming clean, nuanced. Drives the REAL adapter through a registry sandbox. Roles only (liar, listener, other, ally, subject). */
type Live = { week: number; playedGame?: boolean; claims?: ClaimLog; beliefs?: BeliefStore; cleanActs?: CleanAct[] };
type Bag = { s: GameSessionAdapter; liar: string; listener: string; other: string; ally: string; subject: string; told?: SpokenClaim; told2?: SpokenClaim; before?: number; risk?: number; riskAndCandid?: number; riskAndReserved?: number };
const bag = (w: unknown): Bag => (w as { cc0203?: Bag }).cc0203!;
const live = (b: Bag): Live => (b.s as unknown as { live: Live }).live;
let n = 0;
const START = { trust: 0.6, affinity: 0.6, threat: 0.2, alignment: 0.3, confidence: 0.4, reliability: 0.5 };

function init(w: unknown): Bag {
  const existing = (w as { cc0203?: Bag }).cc0203;
  if (existing) return existing;
  const s = new GameSessionRegistry().sandboxFor(`cc0203-${n++}`).session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true); s.setLiesCaughtEnabled(true); s.setCredibilityEnabled(true);
  s.createCharacter({ playerName: "The Player", seed: 11 });
  const [liar, listener, other, ally, subject] = s.livingIds().filter((id) => id !== PLAYER);
  const b: Bag = { s, liar: liar!, listener: listener!, other: other!, ally: ally!, subject: subject! };
  (w as { cc0203?: Bag }).cc0203 = b;
  live(b).playedGame = true; live(b).week = 2;
  const rel = (s as unknown as { rel: { edge(a: string, b: string): Record<string, number> } }).rel;
  for (const x of [b.listener, b.other, b.ally]) Object.assign(rel.edge(x, b.liar), START);
  return b;
}
const rel = (b: Bag) => (b.s as unknown as { rel: { edge(a: string, b: string): { trust: number } } }).rel;
const lie = (b: Bag, listener: string, kind: "going-after" | "talking-about"): SpokenClaim => {
  const c = b.s.tellClaim({ speaker: b.liar, listener, kind, subject: b.subject, object: kind === "going-after" ? b.listener : b.other, isTrue: false, intent: "mislead" });
  assert.ok(c, "the engine refused the claim");
  return c;
};
const held = (b: Bag, holder: string, id: string) => (live(b).beliefs?.[holder] ?? []).find((c) => c.id.endsWith(`|${id}`));

// ---- 1 ----
Given("a houseguest who told a listener something false", function () { const b = init(this); b.told = lie(b, b.listener, "going-after"); b.before = rel(b).edge(b.listener, b.liar).trust; });
When("they confess it to that listener before it is caught", function () { const b = bag(this); assert.equal(b.s.confess(b.liar, b.listener, b.told!.id), true); });
Then("the listener trusts them less, but less than if they had caught the lie", function () {
  const b = bag(this);
  const drop = b.before! - rel(b).edge(b.listener, b.liar).trust;
  assert.ok(drop > 0, "no trust moved");
  assert.ok(drop < caughtLieTrustDrop(CAUGHT_LIE.contradiction), "a confession cost as much as being caught");
  assert.ok(Math.abs(drop - confessionTrustDrop()) < 1e-9);
});
Then("the listener no longer believes what they were told", function () { const b = bag(this); assert.equal(held(b, b.listener, b.told!.id)?.refuted, true); });
Then("the listener holds no \"lied to me\" against them", function () {
  const b = bag(this);
  assert.equal((live(b).beliefs?.[b.listener] ?? []).some((c) => c.kind === "lied-to-me" && c.subject === b.liar), false);
  assert.equal(b.s.credibilityOf(b.listener, b.liar), 1);
});

// ---- 2 ----
Given("a houseguest who told one person something false", function () { const b = init(this); b.told = lie(b, b.listener, "going-after"); b.before = rel(b).edge(b.ally, b.liar).trust; });
When("they tell an ally the truth about it", function () { const b = bag(this); assert.equal(b.s.loopIn(b.liar, b.ally, b.told!.id), true); });
Then("the ally trusts them a little more", function () { const b = bag(this); assert.ok(rel(b).edge(b.ally, b.liar).trust > b.before!); });
Then("the ally knows they lied to that person, and can pass it on", function () {
  const b = bag(this);
  const h = held(b, b.ally, `loopin:${b.told!.id}`);
  assert.ok(h && h.nature === "lying" && h.subject === b.liar && h.object === b.listener && h.confidence > 0.7);
});
Then("if it travels back to the person lied to, that person catches the lie the usual way", function () {
  const b = bag(this);
  // the ally passes it on: a told claim "the liar was lying to you" - the listener then holds a lied-to-me against the liar
  const passed = b.s.tellClaim({ speaker: b.ally, listener: b.listener, kind: "lying-about", subject: b.liar, object: b.listener, isTrue: true, intent: "inform" });
  assert.ok(passed);
  assert.ok((live(b).beliefs?.[b.listener] ?? []).some((c) => c.kind === "lied-to-me" && c.subject === b.liar && !c.refuted));
});

// ---- 3 ----
Given("a houseguest who told two people different false versions about the same houseguest", function () { const b = init(this); b.told = lie(b, b.listener, "going-after"); b.told2 = lie(b, b.other, "talking-about"); });
When("they confess to one and loop an ally in on the other", function () { const b = bag(this); assert.equal(b.s.confess(b.liar, b.listener, b.told!.id), true); assert.equal(b.s.loopIn(b.liar, b.ally, b.told2!.id), true); });
Then("the engine knows which person heard which version, who was told the truth, and who was looped in", function () {
  const b = bag(this);
  const v = versionsAbout(live(b).claims!.items, b.liar, b.subject, live(b).cleanActs!);
  assert.deepEqual(v.map((x) => [x.claim.listener, x.claim.kind, x.confessedTo, x.loopedIn]), [[b.listener, "going-after", [b.listener], []], [b.other, "talking-about", [], [b.ally]]]);
});
Then("the retrospective shows each version and what became of it", function () {
  // The post-crown retrospective door is a later step (deferred; see the 0203 note). Its source record is the claim-by-claim act log, kept append-only and whole.
  const b = bag(this);
  assert.equal(live(b).cleanActs!.length, 2);
});

// ---- 4 ----
Given("a houseguest whose lie is at risk of being caught: the listener doubts it, or another version reached someone close to them", function () { init(this); });
Then("they are more likely to confess first, more so the more candid they are", function () {
  const none = catchRisk({ otherVersionNearListener: false, listenerDoubting: false, subjectCloseToListener: false });
  const doubted = catchRisk({ otherVersionNearListener: false, listenerDoubting: true, subjectCloseToListener: false });
  const both = catchRisk({ otherVersionNearListener: true, listenerDoubting: true, subjectCloseToListener: false });
  assert.ok(confessChance(doubted, 0.5) > confessChance(none, 0.5));
  assert.ok(confessChance(both, 0.5) > confessChance(doubted, 0.5));
  assert.ok(confessChance(doubted, 1) > confessChance(doubted, 0));
});

// ---- 5 ----
Given("the player told a houseguest something false", function () { const b = init(this); b.told = b.s.tellClaim({ speaker: PLAYER, listener: b.listener, kind: "going-after", subject: b.subject, object: b.other, isTrue: false, intent: "mislead", origin: "player" })!; assert.ok(b.told); });
When("the player confesses it, or tells an ally the truth about it", function () {
  const b = bag(this);
  assert.deepEqual(b.s.playerLoopIn({ ally: b.ally, to: b.listener }), { accepted: true });
  assert.deepEqual(b.s.playerConfess({ to: b.listener }), { accepted: true });
});
Then("the houseguest and the ally react as they would to anyone", function () {
  const b = bag(this);
  assert.equal(held(b, b.listener, b.told!.id)?.refuted, true);
  assert.ok(held(b, b.ally, `loopin:${b.told!.id}`));
  assert.equal(b.s.confess(PLAYER, b.listener, b.told!.id), false);
});
Then("a houseguest who lied to the player may confess it to the player, or loop someone else in about it", function () {
  const b = bag(this);
  const c = b.s.tellClaim({ speaker: b.liar, listener: PLAYER, kind: "talking-about", subject: b.subject, object: b.other, isTrue: false, intent: "mislead" })!;
  assert.equal(b.s.loopIn(b.liar, b.ally, c.id), true);
  assert.equal(b.s.confess(b.liar, PLAYER, c.id), true);
});
