import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { liveGameAtPending, liveReplacementLegalSet, liveStateOf } from "../support/liveDecision";
import { generateHouse, portraitDescriptorFor } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { assertNoSentinels, assertNoneAppear } from "../../tests/support/assertions";
import { PLAYER, npc } from "../../src/domain/ids";
import { startLiveSweep, setLive, hiddenFor, plantInHouseguest } from "../support/liveSweep";
import type { SweepTargets } from "../support/liveSweep";

// Reuses (0019): "a pending replacement-nominee decision", "a pending decision with a known legal
// option set", "no decision is pending", "no binding decision is made".
// Reuses (0018): "no Vault sentinel value appears in it" (checks this.lastOutput).

// --- Status panel -------------------------------------------------------------

When("the status panel is rendered", function (this: BbWorld) {
  // PAT-2: render the panel from the LIVE game that carries the planted sentinels (not a fresh adapter).
  const live = startLiveSweep({ seed: 1, user: "pat2-status-panel" });
  setLive(this, live);
  const game = live.sb.session;
  game.updateCeremony({ hoh: npc(1), nominees: [npc(2), npc(3)], vetoHolder: npc(4), vetoUsed: true });
  this.lastView = game.gameStatus();
  this.lastOutput = JSON.stringify(this.lastView); // so the reused 0018 sentinel step applies
});

Then("it shows the current week and phase", function (this: BbWorld) {
  const s = this.lastView as { week: number; phase: string };
  assert.equal(typeof s.week, "number");
  assert.equal(typeof s.phase, "string");
});

Then("it shows the Head of Household and the nominees", function (this: BbWorld) {
  const s = this.lastView as { hoh: { name: string } | null; nominees: unknown[] };
  assert.ok(s.hoh && typeof s.hoh.name === "string");
  assert.equal(s.nominees.length, 2);
});

Then("it shows the veto holder and whether the veto has been used", function (this: BbWorld) {
  const s = this.lastView as { veto: { holder: { name: string } | null; used: boolean } };
  assert.ok(s.veto.holder && typeof s.veto.holder.name === "string");
  assert.equal(s.veto.used, true);
});

Then("it shows no hidden vote or off-screen targeting", function (this: BbWorld) {
  assertNoneAppear(this.lastOutput, hiddenFor(this));
  assert.ok(!/vote|secret|offscreen|hidden/i.test(this.lastOutput));
});

// --- Inline decisions over the legal set --------------------------------------
// Audit 2026-10-25: these used `src/engine/decisions.ts`, a seam production replaced. They now read the
// LIVE game's pending decision (the view the buttons are rendered from) and bind through `submitDecision`.

When("the decision buttons are rendered", function (this: BbWorld) {
  this.liveOptions = this.liveDecision!.sb.session.gameStatus().pending!.options.map((o) => o.id);
});

Then("the buttons are exactly the engine's legal option set", function (this: BbWorld) {
  assert.deepEqual([...this.liveOptions!].sort(), liveReplacementLegalSet(this.liveDecision!.sb).sort());
});

Then("the veto winner is not offered", function (this: BbWorld) {
  const holder = this.liveDecision!.sb.session.snapshot().live!.vetoHolder;
  assert.ok(holder && !this.liveOptions!.includes(holder));
});

Given("a pending decision with rendered option buttons", function (this: BbWorld) {
  this.liveDecision = liveGameAtPending("replacement");
  this.liveOptions = this.liveDecision.pending.options.map((o) => o.id);
});

When("the player taps a legal option", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  this.liveBeatSeq = sb.session.gameStatus().beatSeq;
  this.liveTapped = this.liveOptions![0]!;
  sb.session.submitDecision({ kind: "replacement", replacement: this.liveTapped });
});

Then("the choice is executed through the validated decision path", function (this: BbWorld) {
  const { sb } = this.liveDecision!;
  assert.ok(sb.session.gameStatus().beatSeq > this.liveBeatSeq!, "the tap committed");
  const onTheBlock = sb.session.gameStatus().nominees.map((n) => n.id);
  assert.ok(onTheBlock.includes(this.liveTapped!), "the tapped houseguest is now on the block");
});

Then("the engine re-validates it", function (this: BbWorld) {
  // A tap outside the legal set is rejected by the same validated path (defense in depth): park a fresh
  // game at the same decision and try the veto winner.
  const again = liveGameAtPending("replacement");
  const holder = again.sb.session.snapshot().live!.vetoHolder!;
  const before = liveStateOf(again.sb);
  assert.throws(() => again.sb.session.submitDecision({ kind: "replacement", replacement: holder }));
  assert.equal(liveStateOf(again.sb), before, "the refused tap changed nothing");
});

// --- Illegal can never be presented or chosen ---------------------------------

Then("no option outside that set is offered", function (this: BbWorld) {
  const { pending } = this.liveDecision!;
  assert.ok(!pending.options.some((o) => o.id === PLAYER), "the HOH (the player) is never a nominee option");
});

Then("an attempt to choose outside the set is rejected", function (this: BbWorld) {
  const { sb, pending } = this.liveDecision!;
  assert.throws(() => sb.session.submitDecision({ kind: "nominations", choice: [PLAYER, pending.options[0]!.id] }), /illegal nominee/);
});

// --- Portraits from the generated Character, public facets only ---------------

Given("a generated houseguest with a static Character", function (this: BbWorld) {
  this.portraitSeed = 11;
  this.portraitHg = generateHouse(new SeededRandom(this.portraitSeed)).npcs[0]!;
  // PAT-2: plant sentinels in THIS houseguest's hidden facets + soul, so the portrait sweep can actually fail.
  const planted: SweepTargets = { sentinels: [], hiddenContents: [] };
  plantInHouseguest(this.portraitHg, "portrait", planted);
  setLive(this, planted);
});

When("that houseguest's portrait descriptor is produced", function (this: BbWorld) {
  this.lastView = portraitDescriptorFor(this.portraitHg!);
  this.lastOutput = JSON.stringify(this.lastView);
});

Then("the descriptor draws on the Character's public identity facets", function (this: BbWorld) {
  const d = this.lastView as { appearance: string; age: number; presentation: string; vibe: string };
  assert.ok(d.appearance.length > 0 && d.presentation.length > 0 && d.vibe.length > 0);
  assert.equal(typeof d.age, "number");
});

Then("it excludes competition aptitudes, hidden attributes, and Soul secrets", function (this: BbWorld) {
  for (const banned of ["physical", "mental", "stats", "soul", "volatility", "emotionalBaseline", "emotionalState"]) {
    assert.ok(!this.lastOutput.includes(banned), `leaked: ${banned}`);
  }
});

Then("the same save yields a consistent portrait for that houseguest", function (this: BbWorld) {
  const again = generateHouse(new SeededRandom(this.portraitSeed!)).npcs[0]!;
  assert.deepEqual(portraitDescriptorFor(again), this.lastView);
});

// --- Free-text social play is not a binding decision --------------------------

When("the player chats socially in free text", function (this: BbWorld) {
  // A social chat goes through the LIVE game's command seam (the same game the assertion then checks);
  // it records a scene and executes no decision.
  const { sb } = this.liveDecision!;
  const mate = sb.session.getGameState().house[0]!.id;
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, mate], content: "Just vibing in the kitchen." });
  assert.ok(sb.engine.events.queryAll().some((e) => e.content.includes("Just vibing")), "the chat landed in the live game");
});
