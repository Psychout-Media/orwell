import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { npcExitStance, EXIT_STANCES } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER, npc } from "../../src/domain/ids";

// Feature 0130 — exit interviews. Driven through the live seam (createCharacter → advanceGame /
// submitDecision) + the pure `npcExitStance` derivation. HARD rule: roles only — no names.

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let eiUsers = 0;
function newGame(seed: number): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`xi${eiUsers++}`);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb.session;
}
function playToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("game did not resolve");
}
const state = (m: Record<string, unknown>): LiveSeasonState =>
  ({ mannerByEvictee: { [npc(1)]: m } }) as unknown as LiveSeasonState;

// --- NPC posture is grounded in manner ------------------------------------------------
Given("an evictee who was betrayed on the way out", function (this: BbWorld) {
  this.xiBetrayed = npcExitStance(npc(1), state({ [npc(2)]: { betrayed: true } }));
});
Given("an evictee who was cleanly, respectfully evicted", function (this: BbWorld) {
  this.xiRespected = npcExitStance(npc(1), state({ [npc(2)]: { respected: true } }));
});
When("each gives their exit interview", function () { /* stances derived above */ });
Then("the betrayed evictee leaves bitter", function (this: BbWorld) {
  assert.equal(this.xiBetrayed, "bitter");
});
Then("the respectfully evicted one leaves gracious", function (this: BbWorld) {
  assert.equal(this.xiRespected, "gracious");
  assert.notEqual(this.xiRespected, this.xiBetrayed);
});

// --- fires every staged eviction + retrospective --------------------------------------
Given("a seeded season played to completion", function (this: BbWorld) {
  this.xiSession = newGame(108);
  playToEnd(this.xiSession);
});
When("the season-end retrospective is read", function (this: BbWorld) {
  this.xiRetro = this.xiSession!.seasonRetrospective();
});
Then("every staged eviction has a recorded exit interview", function (this: BbWorld) {
  const r = this.xiRetro!;
  const interviews = r.exitInterviews ?? [];
  assert.ok(interviews.length > 0);
  assert.equal(interviews.length, (r.evictionVotes ?? []).length); // one per staged eviction — none skipped
});
Then("each is a first-person account with a legal posture", function (this: BbWorld) {
  for (const x of this.xiRetro!.exitInterviews ?? []) {
    assert.ok(x.evictee.name);
    assert.ok((EXIT_STANCES as readonly string[]).includes(x.stance));
  }
});

// --- the player's own decision --------------------------------------------------------
When("the exit interview reaches the player", function (this: BbWorld) {
  for (let seed = 1; seed <= 60; seed++) {
    const s = newGame(seed);
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "exit-interview") { this.xiSession = s; this.xiPending = v.pending; return; }
      if (v.pending) resolve(s, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed ≤ 60 reached a player exit interview");
});
Given("a seeded season in which the player is evicted through the staged path", function () { /* found in When */ });
Then("the loop pauses for the player's own answer", function (this: BbWorld) {
  assert.equal(this.xiPending!.kind, "exit-interview");
  assert.equal(this.xiPending!.evictee?.id, PLAYER);
  assert.ok((this.xiPending!.stances?.length ?? 0) > 0);
});
Then("nothing is recorded for the player until they answer", function (this: BbWorld) {
  const rec = this.xiSession!.snapshot().live?.exitInterviews ?? [];
  assert.ok(!rec.some((x) => x.evictee === PLAYER));
});
Then("the player's chosen posture and words are recorded", function (this: BbWorld) {
  this.xiSession!.submitDecision({ kind: "exit-interview", vote: "defiant", statement: "not done" } as SubmitDecisionReq);
  const mine = (this.xiSession!.snapshot().live?.exitInterviews ?? []).find((x) => x.evictee === PLAYER);
  assert.equal(mine?.stance, "defiant");
  assert.equal(mine?.message, "not done");
});

// --- illegal posture refused ----------------------------------------------------------
Given("the player at their exit interview", function (this: BbWorld) {
  for (let seed = 1; seed <= 60; seed++) {
    const s = newGame(seed);
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "exit-interview") { this.xiSession = s; return; }
      if (v.pending) resolve(s, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed ≤ 60 reached a player exit interview");
});
When("they submit a posture that is not offered", function (this: BbWorld) {
  this.xiThrew = false;
  try { this.xiSession!.submitDecision({ kind: "exit-interview", vote: "smug" } as SubmitDecisionReq); }
  catch { this.xiThrew = true; }
});
Then("the decision is refused", function (this: BbWorld) {
  assert.equal(this.xiThrew, true);
});

// --- Vault-safe -----------------------------------------------------------------------
When("the exit-interview stages and the retrospective reel are read", function (this: BbWorld) {
  const s = newGame(42);
  const blobs: string[] = [];
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.eviction?.stage === "exit-interview") blobs.push(JSON.stringify(v.eviction));
    // The producer narration rides the emitted beat's own content — canary it too (not just the view).
    if (v.event && /exit-interview/.test(JSON.stringify(v.event))) blobs.push(JSON.stringify(v.event));
    if (v.pending) resolve(s, v.pending);
    if (v.finished) break;
  }
  blobs.push(JSON.stringify(s.seasonRetrospective()?.exitInterviews ?? []));
  // The admin/God-Mode debug unseal is the ONE admin-facing exit-interview projection — canary it too.
  blobs.push(JSON.stringify(s.producerVaultDump()?.exitInterviews ?? []));
  this.xiBlob = blobs.join("|");
});
Then("no hidden stat, score, or sealed state appears anywhere in them", function (this: BbWorld) {
  assert.ok(!/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(this.xiBlob!));
  assert.ok(!/"(scores|lean|grudge|voteOf|secret|hidden)"/i.test(this.xiBlob!));
});

// --- moves no seeded outcome ----------------------------------------------------------
const BASELINE_108 = ["npc:5","npc:7","npc:1","npc:8","npc:3","npc:12","npc:9","npc:6","npc:13","npc:4","player","npc:15","npc:11","npc:2"]; // re-anchored 2026-11-02 (0044 §9)
Given("the same seed played to completion twice", function (this: BbWorld) {
  const a = newGame(108); playToEnd(a);
  const b = newGame(108); playToEnd(b);
  this.xiOrderA = (a.snapshot().live?.evictionOrder ?? []).slice(0, BASELINE_108.length);
  this.xiOrderB = (b.snapshot().live?.evictionOrder ?? []).slice(0, BASELINE_108.length);
});
Then("the eviction order is identical both times", function (this: BbWorld) {
  assert.deepEqual(this.xiOrderA, this.xiOrderB);
});
Then("it matches the trajectory from before the feature existed", function (this: BbWorld) {
  assert.deepEqual(this.xiOrderA, BASELINE_108);
});
