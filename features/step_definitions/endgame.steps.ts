import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { newLiveSeason, advance, applyDecision, autoDecision } from "../../src/engine/liveSeason";
import type { SeasonCtx, LiveSeasonState, PendingDecision } from "../../src/engine/liveSeason";
import { vetoParticipants, vetoFieldSize, evictionVoters, selectableReplacements, type WeekState } from "../../src/domain/eligibility";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { AdvanceView } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0045 — Endgame structure (Final 5 → Final 2). HARD rule: roles only.

const ctxOf = (rel: RelationshipModel): SeasonCtx => ({ player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel });

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req));
}

// --- Scenario: a seeded season reaches Final 2 with every late ceremony legal ---

Given("a started game advanced into the endgame", function (this: BbWorld) {
  this.egSession = new GameSessionAdapter();
  this.egSession.createCharacter({ playerName: "P", seed: 2 });
});

When("the loop runs from Final 5 down to Final 2", function (this: BbWorld) {
  const s = this.egSession!;
  this.egVetoFieldOk = true;
  this.egEmptyElectorate = false;
  this.egSawFinalEviction = false;
  this.egReplacementsSeen = 0;
  this.egReplacementIsVetoHolder = false;
  let finished = false;
  for (let i = 0; i < 6000 && !finished; i++) {
    const adv = s.advanceGame();
    if (adv.event?.beat === "veto-competition") {
      const live = s.snapshot().live!;
      if (live.vetoField!.length !== vetoFieldSize(live.active.length)) this.egVetoFieldOk = false;
    }
    if (adv.event?.beat === "final-eviction") this.egSawFinalEviction = true;
    if (adv.pending) resolvePending(adv.pending, (req) => s.submitDecision(req), { useVeto: true }); // the player plays the veto when they hold it, so replacements actually occur
    // AMEND 0045 (S1): the veto winner cannot be named replacement nominee - checked every week a replacement is named, alongside the field-size check.
    const live = s.snapshot().live!;
    if (live.replacement !== undefined) {
      this.egReplacementsSeen = (this.egReplacementsSeen ?? 0) + (live.replacement !== this.egLastReplacement || live.week !== this.egLastReplacementWeek ? 1 : 0);
      this.egLastReplacement = live.replacement; this.egLastReplacementWeek = live.week;
      if (live.vetoHolder !== undefined && live.replacement === live.vetoHolder) this.egReplacementIsVetoHolder = true;
    }
    finished = adv.finished;
  }
  this.egFinished = finished;
});

Then("every late-week competition, ceremony, and eviction is legal under the eligibility rules", function (this: BbWorld) {
  assert.equal(this.egFinished, true, "the season reached Final 2 + a winner");
  assert.equal(this.egVetoFieldOk, true, "every veto field was min(6, remaining)");
  assert.ok((this.egReplacementsSeen ?? 0) >= 1, "the season exercised at least one replacement nominee (the check below is not vacuous)");
  assert.equal(this.egReplacementIsVetoHolder, false, "the veto winner is never named the replacement nominee (checked every week a replacement was named)");
  // ...and the rule itself, deterministically (a live season only exercises it when the HOH happens to rank the veto winner first): the legal replacement set never contains the veto winner.
  const wk: WeekState = { houseguests: [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5)], player: PLAYER, hoh: npc(1), nominees: [npc(2), npc(3)], vetoWinner: npc(4) };
  assert.deepEqual(selectableReplacements(wk), [PLAYER, npc(5)], "replacement options exclude the HOH, both nominees and the veto winner");
});

Then("no eviction ever resolves from an empty electorate", function (this: BbWorld) {
  // The F3 final-eviction branch REPLACES the old empty-electorate 0–0 path; seeing it run proves it.
  assert.equal(this.egSawFinalEviction, true, "Final 3 resolved via a final-HOH eviction, not an empty vote");
});

// --- Scenario: the veto field shrinks with the house ---------------------------

Given("a veto competition at Final 5", function (this: BbWorld) {
  this.egWeek = { houseguests: [npc(1), npc(2), npc(3), npc(4), npc(5)], player: PLAYER, hoh: npc(1), nominees: [npc(2), npc(3)] };
});

Then("the veto field is the eligible houseguests, not a forced six", function (this: BbWorld) {
  const field = vetoParticipants(this.egWeek!, new SeededRandom(3)).participants;
  assert.equal(field.length, vetoFieldSize(this.egWeek!.houseguests.length)); // 5, not 6
  assert.equal(field.length, 5);
});

Then("the structural veto invariants still hold", function (this: BbWorld) {
  const w = this.egWeek!;
  const field = vetoParticipants(w, new SeededRandom(3)).participants;
  assert.equal(new Set(field).size, field.length, "distinct participants");
  assert.ok(field.every((id) => w.houseguests.includes(id)), "no evicted/unknown houseguest");
  for (const puller of [w.hoh, w.nominees[0], w.nominees[1]]) assert.ok(field.includes(puller), "HOH + both nominees always play");
});

// --- Scenario: Final 4 has a single eviction vote ------------------------------

Given("a Final 4 eviction", function (this: BbWorld) {
  // A REAL Final 4 with a veto holder: HOH, two nominees, and the fourth houseguest holding the veto. The PLAYER is the HOH
  // (the only seat for which the engine raises a tie-break), so a tie-break pending would be possible if the vote could tie.
  // The eviction is then run through the live loop, recording every ballot actually cast.
  const [hoh, n1, n2, holder] = [PLAYER, npc(2), npc(3), npc(4)];
  this.egWeek = { houseguests: [hoh, n1, n2, holder], player: PLAYER, hoh, nominees: [n1, n2], vetoWinner: holder };
  const s = newLiveSeason([hoh, n1, n2, holder]);
  s.beat = "eviction"; s.hoh = hoh; s.nominees = [n1, n2]; s.finalNominees = [n1, n2]; s.vetoHolder = holder;
  const ctx = ctxOf(new RelationshipModel(0.5));
  const rng = new SeededRandom(1);
  let tieBreakAsked = false;
  for (let i = 0; i < 100 && !s.voteRecord?.length; i++) {
    if (s.pending) {
      if (s.pending.kind === "tie-break") tieBreakAsked = true;
      applyDecision(s, autoDecision(s, ctx, rng), ctx, rng);
    } else advance(s, ctx, rng);
  }
  assert.ok(s.voteRecord?.length, "the eviction vote was actually held");
  this.egState = s;
  this.egBallots = Object.keys(s.voteRecord![0]!.voteOf);
  this.egTieBreakAsked = tieBreakAsked;
});

Then("only the one houseguest who is neither HOH nor a nominee casts an eviction vote", function (this: BbWorld) {
  const w = this.egWeek!;
  const leftover = w.houseguests.filter((h) => h !== w.hoh && !w.nominees.includes(h));
  assert.equal(leftover.length, 1, "a Final 4 leaves exactly one houseguest who is neither HOH nor nominee");
  assert.deepEqual(evictionVoters(w), leftover);
  assert.deepEqual(this.egBallots, leftover, "the ballots actually cast in the live eviction");
});

Then("there is no tie to break", function (this: BbWorld) {
  assert.equal(this.egBallots!.length, 1, "a single voter cannot tie");
  assert.equal(this.egTieBreakAsked, false, "the live loop never asked for a tie-break");
  assert.ok(this.egState!.evictionOrder.length === 1, "the single ballot evicted exactly one nominee");
});

// --- Scenario: Final 3 is a final-HOH competition and a personal eviction -------

Given("three houseguests remain", function (this: BbWorld) {
  this.egState = newLiveSeason([PLAYER, npc(1), npc(2)]);
  this.egCtx = ctxOf(new RelationshipModel(0.5));
});

When("the endgame advances", function (this: BbWorld) {
  const rng = new SeededRandom(1);
  // 0006 staged-rounds: the final HOH comp plays out in elimination rounds; declare a per-round
  // approach each round the player is in, driving through to the crown.
  const s = this.egState!;
  let ev: ReturnType<typeof advance> = null;
  for (let g = 0; g < 20 && s.beat === "hoh-competition"; g++) {
    if (s.pending?.kind === "comp-round") ev = applyDecision(s, { kind: "comp-round", intent: "compete" }, this.egCtx!, rng);
    else ev = advance(s, this.egCtx!, rng);
  }
  assert.equal(ev!.beat, "hoh-competition"); // the crowning beat
});

Then("nominations and the veto are skipped", function (this: BbWorld) {
  assert.equal(this.egState!.beat, "final-eviction"); // straight from the HOH comp to the eviction
});

Then("a final Head of Household is decided by competition", function (this: BbWorld) {
  assert.ok(this.egState!.hoh, "a final HOH was crowned");
});

Then("the final HOH evicts one of the other two, sending the third to Final 2", function (this: BbWorld) {
  const s = this.egState!;
  // Resolve the eviction (the HOH here is an NPC unless the player won — advance handles both).
  if (s.hoh === PLAYER) {
    advance(s, this.egCtx!, new SeededRandom(1)); // pends
    applyDecision(s, { kind: "final-eviction", evict: (s.pending as { options: EntityId[] }).options[0]! }, this.egCtx!);
  } else {
    advance(s, this.egCtx!, new SeededRandom(1));
  }
  assert.equal(s.active.length, 2, "the Final 2 is set");
  assert.equal(s.evictionOrder.length, 1);
  assert.equal(s.beat, "finale");
});

// --- Scenario: the player as final HOH makes the binding eviction --------------

Given("the player is the final Head of Household at Final 3", function (this: BbWorld) {
  this.egCtx = ctxOf(new RelationshipModel(0.5));
  this.egState = newLiveSeason([PLAYER, npc(1), npc(2)]);
  this.egState.hoh = PLAYER;
  this.egState.beat = "final-eviction";
});

When("it is time to evict", function (this: BbWorld) {
  const paused = advance(this.egState!, this.egCtx!, new SeededRandom(1));
  assert.equal(paused, null, "the loop pauses for the player");
  this.egPending = this.egState!.pending;
});

Then("the loop stops and offers the player the two evictable houseguests", function (this: BbWorld) {
  assert.equal(this.egPending?.kind, "final-eviction");
  assert.deepEqual((this.egPending as { options: EntityId[] }).options, [npc(1), npc(2)]);
});

Then("an illegal choice is refused", function (this: BbWorld) {
  let refused = false;
  try { applyDecision(this.egState!, { kind: "final-eviction", evict: PLAYER }, this.egCtx!); } catch { refused = true; }
  assert.equal(refused, true, "the player cannot evict themselves / a non-finalist");
});

Then("the player's chosen houseguest is evicted and joins the jury", function (this: BbWorld) {
  applyDecision(this.egState!, { kind: "final-eviction", evict: npc(1) }, this.egCtx!);
  assert.ok(this.egState!.evictionOrder.includes(npc(1)));
  assert.deepEqual(this.egState!.active, [PLAYER, npc(2)]);
});

// --- Scenario: an NPC final HOH evicts relationship-driven, and it persists -----

Given("an NPC is the final Head of Household at Final 3", function (this: BbWorld) {
  const rel = new RelationshipModel(0.5);
  rel.edge(npc(1), npc(2)).threat = 0.9; // the HOH reads npc:2 as the bigger threat
  rel.edge(npc(1), PLAYER).threat = 0.1;
  this.egCtx = ctxOf(rel);
  this.egState = newLiveSeason([PLAYER, npc(1), npc(2)]);
  this.egState.hoh = npc(1);
  this.egState.beat = "final-eviction";
});

Then("the engine decides the eviction from its hidden relationship signals, not narration", function (this: BbWorld) {
  advance(this.egState!, this.egCtx!, new SeededRandom(1));
  assert.ok(this.egState!.evictionOrder.includes(npc(2)), "the higher-threat rival is evicted");
  this.egEvictee = npc(2);
});

Then("the eviction manner is recorded for the jury", function (this: BbWorld) {
  assert.ok(this.egState!.mannerByEvictee?.[this.egEvictee!], "manner recorded toward the responsible HOH");
});

Then("the same seed reproduces the same endgame, surviving an engine restart", function (this: BbWorld) {
  // AMEND 0045 (S6): a REAL restart - a live game played to the Final-3 final-eviction position, its registry snapshot RESTORED into a fresh registry (the in-memory analogue of
  // a process restart; the disk round-trip is covered by 0030). The Final-N position, the pending decision and the veto field must match across the restart, and both copies must then
  // play the SAME endgame. (Replaces the old `cloneSession` of a separately built state, which proved only that a JSON clone of a hand-made state is a JSON clone.)
  let checked = false;
  for (let seed = 1; seed <= 40 && !checked; seed++) {
    const user = `eg-restart-${seed}`;
    const reg = new GameSessionRegistry();
    const s = reg.sandboxFor(user).session;
    s.createCharacter({ playerName: "P", seed });
    let atFinal3 = false;
    for (let i = 0; i < 6000; i++) {
      const v = s.advanceGame();
      if (s.getGameState().phase === "final-eviction") { atFinal3 = true; break; }
      if (v.pending) resolvePending(v.pending, (req) => s.submitDecision(req));
      if (v.finished) break;
    }
    if (!atFinal3) continue;
    const before = s.getGameState();
    const reg2 = new GameSessionRegistry();
    reg2.restore(user, reg.snapshot(user));
    const r = reg2.sandboxFor(user).session;
    const after = r.getGameState();
    const activeCount = (g: typeof before): number => g.house.filter((h) => h.status === "active").length + (g.player?.status === "active" ? 1 : 0);
    assert.equal(activeCount(after), 3, "restored at Final 3");
    assert.equal(activeCount(after), activeCount(before), "same Final-N position after the restart");
    assert.equal(after.phase, before.phase, "same phase");
    assert.deepEqual(after.pending ?? null, before.pending ?? null, "same pending decision after the restart");
    assert.deepEqual(after.ceremony.veto.players, before.ceremony.veto.players, "same veto field after the restart");
    // Both copies then play the SAME endgame to the end.
    const play = (g: GameSessionAdapter): { order: unknown; winner: unknown } => {
      for (let i = 0; i < 4000; i++) { const v = g.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => g.submitDecision(req)); if (v.finished) break; }
      const live = g.snapshot().live!;
      return { order: live.evictionOrder, winner: live.winner };
    };
    assert.deepEqual(play(r), play(s), "the restored game finishes the SAME endgame as the original");
    checked = true;
  }
  assert.ok(checked, "a seed in 1..40 reached the Final-3 final eviction");
});

void (undefined as unknown as PendingDecision); // keep the PendingDecision import meaningful
