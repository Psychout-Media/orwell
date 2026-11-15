import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0048 — season retrospective & the Vault unsealing. The Wall is ABSOLUTE during play;
// this is its one sanctioned, structurally-gated exception. HARD rule: roles only — no names.

let rtUsers = 0;
const RT_SENTINEL = "SENTINEL-0048-bdd";

function rtResolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

function rtPlayToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (v.pending) rtResolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("the season did not finish within the drive budget");
}

function rtNewGame(w: BbWorld, seed: number): void {
  const reg = new GameSessionRegistry();
  const user = `rt${rtUsers++}`;
  const sb = reg.sandboxFor(user);
  // This scenario pins the LEGACY pre-scheduled twist path (it expects the sealed, never-fired reserve twist to be named on unseal); reactive twists are
  // default-ON since 2026-11-03: their unseal (the armed-but-unfired twists, null week) is gated by tests/unit/retrospectiveReactiveTwists.test.ts, and the
  // season-level twist gates are reactiveTwistsGuard / reactiveTwistsPlayerPaths.
  sb.session.setReactiveTwistsEnabled(false);
  sb.session.createCharacter({ playerName: "The Player", seed });
  // Plant marked hidden state so the sealed/unsealed assertions have teeth: an off-screen
  // scheme + a sealed twist that will never fire.
  sb.engine.events.record({
    id: `rt:bdd:${user}`, ts: 8_500_000, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true,
    content: `${RT_SENTINEL}-${user} scheme`,
  });
  const core = sb.session.snapshot();
  core.live!.reserve = [{ kind: "double-eviction", fireAtBeat: 99 }];
  sb.session.restore(core);
  w.rtRegistry = reg; w.rtUser = user; w.rtSandbox = sb;
}

// --- Scenario: sealed while live ----------------------------------------------------

Given("a live season whose Vault holds off-screen scheming and confessionals", function (this: BbWorld) {
  rtNewGame(this, 4);
  // A few beats so confessionals/off-screen life exist — but NOT to the finale.
  const s = this.rtSandbox!.session;
  for (let i = 0; i < 20; i++) {
    const v = s.advanceGame();
    if (v.pending) rtResolve(s, v.pending);
  }
  assert.ok(!s.getGameState().player || !s.seasonRecap().finished, "the season is still live");
});

When("the player requests the unsealed story before the season is over", function (this: BbWorld) {
  this.rtRetro = this.rtSandbox!.session.seasonRetrospective();
  this.lastOutput = JSON.stringify(this.rtSandbox!.session.getGameState())
    + JSON.stringify(this.rtSandbox!.session.seasonRecap())
    + JSON.stringify(this.rtSandbox!.player.getVisibleState())
    + JSON.stringify(this.rtRetro);
});

Then("nothing hidden is returned", function (this: BbWorld) {
  assert.equal(this.rtRetro, null, "the gate holds: no finished season, no unsealing");
});

Then("no Vault sentinel value appears on any surface", function (this: BbWorld) {
  assert.ok(!this.lastOutput.includes(RT_SENTINEL), "the sealed story never leaks while live");
});

// --- Scenario: unseals after the winner ----------------------------------------------

Given("a finished season with a crowned winner", function (this: BbWorld) {
  rtNewGame(this, 4);
  rtPlayToEnd(this.rtSandbox!.session);
});

When("the player triggers the season retrospective", function (this: BbWorld) {
  this.rtRetro = this.rtSandbox!.session.seasonRetrospective();
});

Then("the unsealed hidden story is returned — off-screen scheming, confessionals, and any unfired twist", function (this: BbWorld) {
  const retro = this.rtRetro!;
  assert.ok(retro, "the finished season unseals");
  assert.ok(retro.winner, "the winner heads the retrospective");
  const story = JSON.stringify(retro.hiddenStory);
  assert.ok(story.includes(RT_SENTINEL), "the off-screen scheme is in the story");
  // The hidden story is rendered READABLY (0048 P1 fix): each row's `type` is a plain category label for
  // the FE's "[type] content" line, never a raw kind slug — confessionals carry the label "Confessional".
  assert.ok(retro.hiddenStory.some((h) => h.type === "Confessional"), "the confessionals are in the story");
  assert.deepEqual(retro.twists, [{ kind: "double-eviction", firedWeek: null }], "the unfired twist is named");
});

// --- Scenario: scoped to that finished season only ------------------------------------

Given("one finished season and one live season for different users", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const a = reg.sandboxFor("rt-done");
  const b = reg.sandboxFor("rt-live");
  a.session.createCharacter({ playerName: "The Player", seed: 5 });
  b.session.createCharacter({ playerName: "The Player", seed: 6 });
  a.engine.events.record({ id: "rt:a", ts: 8_600_000, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `${RT_SENTINEL}-of-the-finished-user` });
  b.engine.events.record({ id: "rt:b", ts: 8_600_001, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `${RT_SENTINEL}-of-the-live-user` });
  rtPlayToEnd(a.session);
  this.rtSandbox = a;
  this.rtSandboxB = b;
});

When("each user triggers the retrospective", function (this: BbWorld) {
  this.rtRetro = this.rtSandbox!.session.seasonRetrospective();
  this.rtRetroB = this.rtSandboxB!.session.seasonRetrospective();
});

Then("only the finished season returns its hidden story", function (this: BbWorld) {
  assert.ok(this.rtRetro, "the finished season unseals");
  assert.ok(JSON.stringify(this.rtRetro).includes("of-the-finished-user"));
});

Then("the live season returns nothing, and no other user's content appears", function (this: BbWorld) {
  assert.equal(this.rtRetroB, null, "the live season stays sealed");
  assert.ok(!JSON.stringify(this.rtRetro).includes("of-the-live-user"), "cross-user isolation holds (0021)");
});

// --- Scenario: the recap is the record --------------------------------------------------

Given("a finished season", function (this: BbWorld) {
  rtNewGame(this, 7);
  rtPlayToEnd(this.rtSandbox!.session);
});

When("the season recap is assembled", function (this: BbWorld) {
  this.rtRecap = this.rtSandbox!.session.seasonRecap();
});

Then("its highlights come from the recorded events — HOH reigns, nominations, vetoes, evictions, deals", function (this: BbWorld) {
  const recap = this.rtRecap!;
  assert.ok(recap.finished && recap.winner, "the recap covers the finished season");
  assert.ok(recap.highlights.some((h) => /Head of Household/.test(h)), "HOH reigns recorded");
  assert.ok(recap.highlights.some((h) => /nominates/.test(h)), "nominations recorded");
  assert.ok(recap.highlights.some((h) => /[Vv]eto/.test(h)), "veto beats recorded");
  assert.ok(recap.highlights.some((h) => /evict/i.test(h)), "evictions recorded");
  assert.equal(recap.evicted.length, 14, "the full eviction order");
});

Then("every highlight it lists is a recorded, non-hidden event in the stores", function (this: BbWorld) {
  const recorded = new Set(this.rtSandbox!.engine.events.queryAll().filter((e) => !e.hidden).map((e) => e.content));
  for (const h of this.rtRecap!.highlights) assert.ok(recorded.has(h), `not in the record: ${h}`);
});

// --- Scenario: finished → new season -----------------------------------------------------

When("the player starts a new season", function (this: BbWorld) {
  this.rtArchive = this.rtRegistry!.snapshot(this.rtUser!);
  const fresh = this.rtRegistry!.resetUser(this.rtUser!);
  fresh.session.createCharacter({ playerName: "The Player", seed: 8 });
  this.rtSandbox = fresh;
});

Then("the snapshot taken of the prior season before the reset still reads as finished, with its winner", function (this: BbWorld) {
  assert.equal(this.rtArchive!.live?.finished, true, "the archived season stays finished");
  assert.ok(this.rtArchive!.live?.winner, "its winner stands");
});

Then("a fresh game begins with one active game for that user", function (this: BbWorld) {
  const view = this.rtSandbox!.session.getGameState();
  assert.ok(view.started && view.week === 1, "a fresh week-1 game");
  assert.equal(this.rtSandbox!.session.seasonRetrospective(), null, "the new season is sealed again");
  assert.equal(this.rtRegistry!.userCount(), 1, "one active game per user (0021)");
});
