import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { evolveEmotion, composedEmotion, effectiveDisposition, settleScaleOf } from "../../src/engine/emotionalArc";
import { nominationStrategy } from "../../src/engine/season";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import type { Competitor } from "../../src/domain/competitionOutcome";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { VOL_OF, dispositionOf } from "../../src/engine/characterFactory";
import type { Soul } from "../../src/engine/characterFactory";
import type { UserSandbox } from "../../src/composition/registry";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0124 — deeper character evolution: independent affect axes, temperament drift, disposition-tuned
// reactivity. Hidden layer only, calibration-safe (soul-depth off ⇒ 0041 byte-identical). Roles only.

const soul = (over: Partial<Soul> = {}): Soul =>
  ({ emotionalBaseline: 0.5, volatility: 0.4, emotionalState: 0.5, emotionalHistory: [], memory: [], ...over });
const DEPTH = { soulDepth: true } as const;

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

function evoGame(user: string, seed: number, soulDepth: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  if (soulDepth) sb.session.setSoulDepthEnabled(true);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb;
}

// ── Scenario: independent axes ────────────────────────────────────────────────────────────────
Given("a houseguest who won a competition and then got blindsided, with soul-depth on", function (this: BbWorld) {
  const s = soul();
  evolveEmotion(s, "comp-win", undefined, undefined, DEPTH);
  evolveEmotion(s, "blindside", undefined, undefined, DEPTH);
  this.dceSoul = s;
});

Then("their confidence and their distress are both high at once", function (this: BbWorld) {
  assert.ok(this.dceSoul!.confidence! > 0.6, "still riding the win");
  assert.ok(this.dceSoul!.distress! > 0.6, "AND rattled at the same time");
});

Then("with soul-depth off only the single calm-versus-rattled dial moves", function () {
  const s = soul();
  evolveEmotion(s, "comp-win");
  evolveEmotion(s, "blindside");
  assert.equal(s.confidence, undefined);
  assert.equal(s.distress, undefined);
  assert.equal(composedEmotion(s), s.emotionalState); // falls back to the single scalar
});

// ── Scenario: distress drags a competition ────────────────────────────────────────────────────
Given("a confident-but-distressed houseguest versus a purely confident one", function (this: BbWorld) {
  const confident = soul();
  evolveEmotion(confident, "comp-win", undefined, undefined, DEPTH);
  const distressed = soul();
  evolveEmotion(distressed, "comp-win", undefined, undefined, DEPTH);
  evolveEmotion(distressed, "blindside", undefined, undefined, DEPTH);
  const A = npc(1), B = npc(2), C = npc(3);
  const field = (emo: number): Competitor[] => [
    { id: A, stats: { physical: 0.6, mental: 0.5, social: 0.5 }, emotionalState: emo },
    { id: B, stats: { physical: 0.52, mental: 0.5, social: 0.5 } },
    { id: C, stats: { physical: 0.5, mental: 0.5, social: 0.5 } },
  ];
  this.dceCompConfident = resolveCompetition(field(composedEmotion(confident)), "physical", new CompetitionIntents(), new SeededRandom(3)).scores[A];
  this.dceCompDistressed = resolveCompetition(field(composedEmotion(distressed)), "physical", new CompetitionIntents(), new SeededRandom(3)).scores[A];
});

When("each plays a competition", function () { /* both resolved deterministically in the Given */ });

Then("the distressed one competes measurably worse despite the confidence", function (this: BbWorld) {
  assert.ok((this.dceCompDistressed ?? 0) < (this.dceCompConfident ?? 0) - 0.1, "distress drags the composed read");
});

// ── Scenario: temperament drift ───────────────────────────────────────────────────────────────
Given("a trusting houseguest betrayed several times, with soul-depth on", function (this: BbWorld) {
  const s = soul();
  for (let i = 0; i < 3; i++) evolveEmotion(s, "betrayed", undefined, undefined, DEPTH);
  this.dceSoul = s;
});

Then("their effective temperament drifts toward paranoia", function (this: BbWorld) {
  assert.equal(effectiveDisposition("neutral", this.dceSoul!), "clash");
});

Then("their static character disposition is unchanged", function (this: BbWorld) {
  // effectiveDisposition is a pure READ over a passed-in baseline — it never mutates it.
  assert.ok(["bond", "neutral"].includes(effectiveDisposition("bond", this.dceSoul!)));
});

Then("a calm stretch reverts the temperament toward their true baseline", function (this: BbWorld) {
  for (let i = 0; i < 8; i++) evolveEmotion(this.dceSoul!, "calm", undefined, undefined, DEPTH);
  assert.equal(effectiveDisposition("neutral", this.dceSoul!), "neutral");
});

// ── Scenario: hardened temperament bends a decision ───────────────────────────────────────────
Given("the same houseguest before and after they hardened", function (this: BbWorld) {
  const hoh = npc(1), top = npc(2), trusted = npc(3), distrusted = npc(4);
  this.dceHoh = hoh;
  const rel = new RelationshipModel(0.5);
  const set = (to: ReturnType<typeof npc>, threat: number, trust: number): void => {
    const e = rel.edge(hoh, to); e.threat = threat; e.trust = trust;
  };
  set(top, 0.9, 0.55); set(trusted, 0.6, 0.9); set(distrusted, 0.5, 0.05);
  const active = [hoh, top, trusted, distrusted];
  // Their true self (a trusting bond disposition) versus their hardened self (clash, via the drift).
  this.dceNomsBase = nominationStrategy(hoh, active, rel, { mood: 0.5, disposition: "bond" });
  this.dceNomsHardened = nominationStrategy(hoh, active, rel, { mood: 0.5, disposition: "clash" });
});

When("each makes an HOH nomination decision", function () { /* both computed in the Given */ });

Then("the hardened version nominates differently from their trusting self", function (this: BbWorld) {
  assert.notDeepEqual(this.dceNomsHardened, this.dceNomsBase);
});

Then("the decision never breaks a hard rule", function (this: BbWorld) {
  for (const noms of [this.dceNomsBase!, this.dceNomsHardened!]) {
    assert.equal(new Set(noms).size, 2, "two distinct nominees");
    assert.ok(!noms.includes(this.dceHoh!), "the HOH is never on their own block");
  }
});

// ── Scenario: temperamental more reactive ─────────────────────────────────────────────────────
Given("a combative houseguest and an even-keeled houseguest facing the same shock, with soul-depth on", function (this: BbWorld) {
  const clash = soul({ volatility: VOL_OF.clash, settleScale: settleScaleOf("clash") });
  const bond = soul({ volatility: VOL_OF.bond, settleScale: settleScaleOf("bond") });
  evolveEmotion(clash, "blindside", undefined, undefined, DEPTH);
  evolveEmotion(bond, "blindside", undefined, undefined, DEPTH);
  this.dceClashSwing = Math.abs(clash.emotionalState - 0.5);
  this.dceBondSwing = Math.abs(bond.emotionalState - 0.5);
  // stash the souls for the settle check by re-deriving in the Then via fresh spiked souls
  this.dceSoul = clash;
});

Then("the combative houseguest's on-edge dial swings harder", function (this: BbWorld) {
  assert.ok(this.dceClashSwing! > this.dceBondSwing!, "the temperamental one is more sensitive");
});

Then("the combative houseguest settles slower over a calm stretch", function () {
  const clash = soul({ volatility: 0.9, settleScale: settleScaleOf("clash") });
  const bond = soul({ volatility: 0.9, settleScale: settleScaleOf("bond") });
  // settleScale only applies under the soul-depth gate (byte-identical to 0041 otherwise), so pass DEPTH.
  for (let i = 0; i < 4; i++) { evolveEmotion(clash, "calm", undefined, undefined, DEPTH); evolveEmotion(bond, "calm", undefined, undefined, DEPTH); }
  assert.ok(clash.volatility > bond.volatility, "agitation lingers on the temperamental one");
});

// ── Scenario: reactivity disposition-derived + calibration-safe ────────────────────────────────
Given("soul-depth off", function (this: BbWorld) {
  this.dceSandbox = evoGame("dce-off", 5, false);
});

Then("an NPC's starting reactivity is the legacy random draw and the seeded spine is unmoved", function (this: BbWorld) {
  const house = this.dceSandbox!.session.snapshot().house!;
  const anyOffTable = house.npcs.some((hg) => hg.soul.volatility !== VOL_OF[dispositionOf(hg.character.archetype)]);
  assert.ok(anyOffTable, "the legacy random draw is in play, not the disposition table");
  assert.ok(house.npcs.every((hg) => hg.soul.settleScale === undefined));
});

Then("with soul-depth on it is derived from their disposition, drawing no extra randomness", function () {
  // Two same-seed on-games are identical (draw-preserving: the post-pass consumes no rng).
  const a = evoGame("dce-on-a", 9, true).session.snapshot().house!;
  const b = evoGame("dce-on-b", 9, true).session.snapshot().house!;
  for (const hg of a.npcs) assert.equal(hg.soul.volatility, VOL_OF[dispositionOf(hg.character.archetype)]);
  assert.deepEqual(a.npcs.map((n) => n.soul.volatility), b.npcs.map((n) => n.soul.volatility));
});

// ── Scenario: Vault-free + deterministic ──────────────────────────────────────────────────────
Given("a started game whose houseguests evolved with soul-depth on", function (this: BbWorld) {
  const sb = evoGame("dce-wall", 7, true);
  for (let i = 0; i < 60; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolveLegally(sb.session, v.pending);
    if (v.finished) break;
  }
  this.dceSandbox = sb;
});

When("the player's surfaces are read", function (this: BbWorld) {
  const sb = this.dceSandbox!;
  this.lastOutput = [
    JSON.stringify(sb.session.getGameState()),
    JSON.stringify(sb.session.gameStatus()),
    JSON.stringify(sb.session.getMomentPrompt({})),
  ].join("\n---\n");
});

Then("no affect axis, temperament, or reactivity number appears", function (this: BbWorld) {
  const house = this.dceSandbox!.session.snapshot().house!;
  assert.ok(house.npcs.some((n) => n.soul.distress !== undefined), "there IS hidden evolved state to leak");
  for (const field of ["distress", "confidence", "temperamentDrift", "settleScale", "volatility", "emotionalState"]) {
    assert.ok(!this.lastOutput!.includes(`"${field}":`), `the hidden soul field ${field} leaked`);
  }
  void PLAYER;
});

Then("the same seed reproduces the same axes, drift, and reactivity", function () {
  const a = evoGame("dce-det-a", 11, true);
  const b = evoGame("dce-det-b", 11, true);
  const drive = (sb: UserSandbox): void => {
    for (let i = 0; i < 40; i++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolveLegally(sb.session, v.pending);
      if (v.finished) break;
    }
  };
  drive(a); drive(b);
  const axes = (sb: UserSandbox): string =>
    sb.session.snapshot().house!.npcs
      .map((n) => `${n.soul.volatility}|${n.soul.settleScale ?? ""}|${n.soul.confidence ?? ""}|${n.soul.distress ?? ""}|${n.soul.temperamentDrift ?? ""}`)
      .join(",");
  assert.equal(axes(a), axes(b));
});
