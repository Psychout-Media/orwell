import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import {
  newLiveSeason, advance, applyDecision,
  type LiveSeasonState, type SeasonCtx, type BeatEvent,
} from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AdvanceView } from "../../src/ports/GameSession";
import { liveGameAtPlayerPending, cloneSnapshot, freshScratch } from "../support/liveEvictionNight";

// E34 (0047 amendment) + E37 (0037 amendment) — the player's goodbye message and the
// player-juror's question are REAL pending decisions: the engine never speaks for the player.
// HARD rule: roles only — no names.

const ctxOf = (rel: RelationshipModel): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel,
});

// --- E34: the player's goodbye message (LIVE: real pendings on the real adapter) ---
// AMEND 0047 (2026-11-03): these steps used to drive a hand-built 7-person pure `liveSeason`. They now play a real
// seeded game through `advanceGame`/`submitDecision` until the PLAYER survives an eviction and faces the engine's own
// `goodbye-message` pending (seed-searched; it fails loudly if no seed reaches it).

Given("an eviction whose result has landed with the player surviving", function (this: BbWorld) {
  this.night = freshScratch();
});

When("the goodbye stage reaches the player", function (this: BbWorld) {
  const n = this.night!;
  const found = liveGameAtPlayerPending("goodbye-message");
  n.game = found.game; n.pending = found.pending; n.seen = found.seen;
  n.snap = cloneSnapshot(found.game);
});

Then("the loop pauses for the player's goodbye message", function (this: BbWorld) {
  const n = this.night!;
  const p = n.pending!;
  assert.equal(p.kind, "goodbye-message");
  assert.equal(p.by.id, PLAYER, "the goodbye is the player's own");
  assert.deepEqual(p.options.map((o) => o.id), ["warm", "respectful", "cold"], "the player chooses among the three tones");
  assert.notEqual(p.evictee?.id, PLAYER, "the player is the sender, not the evictee");
  // Genuinely paused: the engine state holds the same pending, and advancing again changes nothing.
  assert.equal(n.game!.session.snapshot().live?.pending?.kind, "goodbye-message");
  const again = n.game!.session.advanceGame();
  assert.equal(again.pending?.kind, "goodbye-message", "advancing again still waits on the player");
  assert.equal(again.beatSeq, n.seen[n.seen.length - 1]!.beatSeq, "no beat fired while the player had not decided");
});

Then("no player goodbye beat exists before the decision is resolved", function (this: BbWorld) {
  const n = this.night!;
  // Only THIS night's beats count: from the eviction that sent the evictee out up to the pending.
  const commit = n.seen.map((v) => v.event?.beat).lastIndexOf("eviction");
  assert.ok(commit >= 0, "the night's eviction beat was seen on the way");
  const goodbyes = n.seen.slice(commit).filter((v) => v.event?.beat === "eviction-goodbye");
  assert.ok(goodbyes.length > 0, "the house's own goodbyes were staged before the player's turn");
  for (const v of goodbyes) assert.notEqual(v.event!.participants?.[0]?.id, PLAYER, "the engine never authored a player goodbye");
});

Then("the player's chosen tone folds into the evictee's manner toward the player", function (this: BbWorld) {
  const n = this.night!;
  const s = n.game!.session;
  const evictee = n.pending!.evictee!.id;
  const before = s.snapshot().live!.mannerByEvictee?.[evictee]?.[PLAYER]?.goodbye;
  assert.equal(before, undefined, "no tone is on file for the player before they choose");
  const sub = s.submitDecision({ kind: "goodbye-message", vote: "cold" });
  assert.equal(sub.event?.beat, "eviction-goodbye");
  assert.equal(sub.event?.participants?.[0]?.id, PLAYER, "the goodbye beat is the player's own");
  // The fold honors the player's CHOICE (goodbyeMannerFor), exactly as an NPC tone would fold.
  // SOC-NEW-1: the tone is recorded as the `goodbye` field (applied with precedence in juryLean).
  assert.equal(s.snapshot().live!.mannerByEvictee![evictee]![PLAYER]!.goodbye, "cold");
});

// --- AMEND 0047 item 1: after the goodbye the night ends at the result, never stalling at the interview ---

When("the player records a respectful goodbye", function (this: BbWorld) {
  const n = this.night!;
  const s = n.game!.session;
  n.facts.week = s.snapshot().live!.week;
  n.facts.evictee = n.pending!.evictee!.id;
  n.submitted = s.submitDecision({ kind: "goodbye-message", vote: "respectful" });
  // The engine still owes the interview and the result: only advanceGame delivers them. Bounded (<= 6 steps).
  let last: AdvanceView = n.submitted;
  for (let i = 0; i < 6 && last.eviction && !last.pending && !last.finished; i++) {
    last = s.advanceGame({ expectedBeatSeq: last.beatSeq });
    n.chain.push(last);
  }
});

Then("the night runs on through the exit interview to the result in a few steps", function (this: BbWorld) {
  const n = this.night!;
  assert.equal(n.submitted!.pending, null, "no player gate remains after the goodbye");
  assert.ok(n.submitted!.eviction, "the night is still staging right after the goodbye");
  const beats = n.chain.map((v) => v.event?.beat);
  assert.ok(n.chain.length <= 6, `bounded: the night finished in ${n.chain.length} steps`);
  const interview = beats.indexOf("exit-interview");
  assert.ok(interview >= 0, `the exit interview is staged (saw ${beats.join(" -> ")})`);
  assert.equal(beats[beats.length - 1], "eviction-result", `the night ends at the result, not at the interview (saw ${beats.join(" -> ")})`);
  assert.ok(interview < beats.length - 1, "the result comes AFTER the interview");
  assert.equal(n.chain[n.chain.length - 1]!.eviction ?? null, null, "the eviction projection is gone once the result lands");
});

Then("no further decision is asked of the player on the way", function (this: BbWorld) {
  const n = this.night!;
  for (const v of n.chain) {
    assert.equal(v.pending, null, "the night never asks the surviving player for anything after their goodbye");
    assert.equal(v.finished, false);
  }
  assert.equal(n.game!.session.snapshot().live!.pending, undefined, "nothing is pending in the engine either");
});

Then("the evictee is out and the next week's first phase opens", function (this: BbWorld) {
  const n = this.night!;
  const live = n.game!.session.snapshot().live!;
  const evictee = n.facts.evictee as string;
  assert.ok(!live.active.includes(evictee as never), "the evictee is out of the house");
  assert.equal(live.evictionOrder[live.evictionOrder.length - 1], evictee, "the evictee is recorded as the latest eviction");
  assert.equal(live.eviction, undefined, "the eviction sub-loop is cleared");
  assert.ok(
    (live.exitInterviews ?? []).some((x) => x.evictee === evictee && x.week === n.facts.week),
    "the evictee's exit interview is on the record",
  );
  assert.ok(["hoh-competition", "twist-reveal", "finale"].includes(live.beat), `the house rolled on to its next phase (beat is ${live.beat})`);
  if (live.beat === "hoh-competition") assert.equal(live.week, (n.facts.week as number) + 1, "the next week's HOH phase");
});

// --- E37: the player-juror question ----------------------------------------------

Given("a finale where the player sits on the jury", function (this: BbWorld) {
  const A = npc(50), B = npc(51);
  const jury = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6), npc(7), npc(8)];
  const rel = new RelationshipModel(0.5);
  for (const j of jury) {
    Object.assign(rel.edge(j, A), { trust: 0.5, affinity: 0.5, threat: 0.3 });
    Object.assign(rel.edge(j, B), { trust: 0.5, affinity: 0.5, threat: 0.3 });
  }
  const s: LiveSeasonState = {
    week: 9, beat: "finale", active: [A, B], vetoUsed: false,
    evictionOrder: [...jury], finished: false,
  };
  this.agS = s; this.agCtx = ctxOf(rel); this.agFinalists = [A, B];
});

When("the question round reaches the player's seat", function (this: BbWorld) {
  const s = this.agS!;
  const rng = new SeededRandom(5);
  this.agQuestioned = [];
  // Drive the WHOLE finale, recording each player-juror question pause as it lands.
  for (let g = 0; g < 1000 && !s.finished; g++) {
    if (s.pending?.kind === "juror-question") {
      this.agQuestioned.push(s.pending.finalist);
      applyDecision(s, { kind: "juror-question", question: "what was your game?" }, this.agCtx!);
      continue;
    }
    if (s.pending?.kind === "juror-vote") {
      applyDecision(s, { kind: "juror-vote", vote: s.pending.finalists[0] }, this.agCtx!);
      continue;
    }
    advance(s, this.agCtx!, rng);
  }
});

Then("the loop pauses for the player's juror question to each finalist", function (this: BbWorld) {
  assert.deepEqual([...this.agQuestioned!].sort(), [...this.agFinalists!].sort(),
    "the player-juror questioned BOTH finalists themselves");
});

Then("the juror question is scoreless", function (this: BbWorld) {
  // Same fixture, same seed, radically different question text ⇒ identical winner and reveals.
  const run = (question: string): string => {
    const A = npc(50), B = npc(51);
    const jury = [PLAYER, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6), npc(7), npc(8)];
    const rel = new RelationshipModel(0.5);
    for (const j of jury) {
      Object.assign(rel.edge(j, A), { trust: 0.5, affinity: 0.5, threat: 0.3 });
      Object.assign(rel.edge(j, B), { trust: 0.5, affinity: 0.5, threat: 0.3 });
    }
    const s: LiveSeasonState = {
      week: 9, beat: "finale", active: [A, B], vetoUsed: false,
      evictionOrder: [...jury], finished: false,
    };
    const ctx = ctxOf(rel);
    const rng = new SeededRandom(42);
    const reveals: string[] = [];
    for (let g = 0; g < 1000 && !s.finished; g++) {
      if (s.pending?.kind === "juror-question") { applyDecision(s, { kind: "juror-question", question }, ctx); continue; }
      if (s.pending?.kind === "juror-vote") { applyDecision(s, { kind: "juror-vote", vote: s.pending.finalists[1] }, ctx); continue; }
      const ev: BeatEvent | null = advance(s, ctx, rng);
      if (ev?.beat === "finale-reveal") reveals.push(`${ev.participants[0]}->${ev.participants[1]}`);
    }
    return `${s.winner}|${reveals.join(",")}`;
  };
  assert.equal(run("a long, pointed, devastating question"), run("x"),
    "the question text sways nothing — scoreless by construction");
});

Then("the finalist's answer remains engine-chosen", function (this: BbWorld) {
  const s = this.agS!;
  // Both finalists' answers to the player-juror were recorded by the ENGINE for the tally.
  for (const fin of this.agFinalists!) {
    assert.ok(s.finale!.appeals[fin]?.[PLAYER], "the engine recorded the finalist's answer to the player");
  }
});
