import { endHeldNightSync } from "../../tests/support/heldNight";
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { npcExitStance, EXIT_STANCES } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { PLAYER, npc } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";
import { liveGameAtPlayerPending, cloneSnapshot, resumeFrom, advanceUntil, freshScratch } from "../support/liveEvictionNight";

// Feature 0130 — exit interviews. Driven through the live seam (createCharacter → advanceGame /
// submitDecision) + the pure `npcExitStance` derivation. HARD rule: roles only — no names.

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => void s.submitDecision(req));
}

let eiUsers = 0;
function newGame(seed: number, shippedPremiere = false): GameSessionAdapter {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`xi${eiUsers++}`);
  // A9 flip: the BDD lane pins the premiere-entrances flag OFF (cucumber.cjs); the seed-108 ANCHOR is the SHIPPED trajectory, so it opts the entrances back IN.
  if (shippedPremiere) sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "P", seed });
  return sb.session;
}
function playToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.held) endHeldNightSync(s); // ORW-116: a held night is the player's: time passes, then they turn in
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

// --- deterministic and pinned (AMEND 0130, 2026-11-03: was "moves no seeded outcome") -------
// This block proves the seeded spine is DETERMINISTIC (same seed twice => same order) and PINNED (the order matches the approved
// anchor below). It does NOT carry the inertness claim: that the exit-interview beat draws no rng, is clock-free (an INERT beat)
// and replays the pre-0130 eviction order byte-for-byte under ORWELL_FLAGS_OFF=1 rests on tests/unit/exitInterview.test.ts
// ("is an INERT beat", "byte-identical spine"). The seed-108 anchor is RE-ANCHORED on every owner-approved balance change.
// Re-captured 2026-11-04 (#2059, memories ON by default): the tail after npc:3 moved from [npc:4,npc:13,npc:9] to [npc:9,npc:13,npc:14]; the two same-seed runs still agree (determinism holds).
const BASELINE_108 = ["npc:6","npc:1","npc:10","npc:8","npc:12","npc:7","npc:15","npc:11","npc:5","npc:3","npc:4","npc:13","npc:14","player"]; // re-anchored 2026-11-07 for ORW-116 (Ryne's ruling: the clock runs from the afternoon premiere entry, no phase advance moves it, the night is the player's; both same-seed runs identical, the first nine evictions unchanged); earlier: re-anchored 2026-11-05 for the 23 strategy layers + DRIVE_DECISIONS ON by default (PO: "if it's built, turn it on"; determinism confirmed: both runs identical); earlier: re-captured 2026-11-04 for REACTIVE TWISTS ON by default (PO ruling 2026-11-03; a battle-back/double eviction reshape this seed late); earlier: re-anchored again 2026-11-03 under the SAME default-flag profile for the comp-win threat retune (#1953); earlier: the DEFAULT FLIP (26 flags now code defaults — the deployed game; the owner-approved balance change). Earlier: 0044 §9; #1948 (replacement branches on the stored HOH target)
Given("the same seed played to completion twice", function (this: BbWorld) {
  const a = newGame(108, true); playToEnd(a);
  const b = newGame(108, true); playToEnd(b);
  this.xiOrderA = (a.snapshot().live?.evictionOrder ?? []).slice(0, BASELINE_108.length);
  this.xiOrderB = (b.snapshot().live?.evictionOrder ?? []).slice(0, BASELINE_108.length);
});
Then("the eviction order is identical both times", function (this: BbWorld) {
  assert.deepEqual(this.xiOrderA, this.xiOrderB);
});
// The anchor is the APPROVED seeded trajectory: it is re-captured, with the change recorded next to it, whenever an owner-approved
// balance change legitimately reshapes the seeded spine (0044 §9, #1948). The exit-interview beat's inertness is proven in
// tests/unit/exitInterview.test.ts (see above); here the two same-seed runs agree and the order matches the current anchor.
Then("it matches the approved seeded trajectory anchor", function (this: BbWorld) {
  // The anchor is captured under the DEFAULT profile; a diagnostic ORWELL_FLAGS_OFF=1 (or a per-flag =0) run plays a different game on purpose.
  assert.ok(
    process.env.ORWELL_FLAGS_OFF !== "1" && !Object.keys(process.env).some((k) => k.startsWith("ORWELL_") && k !== "ORWELL_PREMIERE_ENTRANCES" && k !== "ORWELL_BEDTIME_GATE" && k !== "ORWELL_PHILOSOPHIES" && k !== "ORWELL_CALM_PRESENCE" && /^(0|false|off)$/i.test(process.env[k] ?? "")),
    "the seed-108 anchor is captured under the default flag profile — unset ORWELL_FLAGS_OFF / any ORWELL_*=0 to run it",
  );
  assert.deepEqual(this.xiOrderA, BASELINE_108);
});

// --- restart mid-interview (AMEND 0130, 2026-11-03) -----------------------------------
// A real seeded game parked at the player's own exit-interview pending; the registry snapshot is restored into a FRESH registry
// (an in-memory snapshot rebuild; the disk save/load round-trip is covered by the durable-persistence scenarios, 0030) and the same pending must stand, then answering it must complete the night.
Given("the player evicted and facing their exit interview", function (this: BbWorld) {
  const found = liveGameAtPlayerPending("exit-interview");
  this.night = { ...freshScratch(), game: found.game, pending: found.pending, seen: found.seen, snap: cloneSnapshot(found.game) };
});

When("the engine restarts at the exit interview", function (this: BbWorld) {
  const n = this.night!;
  n.facts.beforeLive = JSON.stringify(n.game!.session.snapshot().live?.pending ?? null);
  const resumed = resumeFrom(n.snap!, n.game!.seed, "restart-interview");
  n.facts.resumed = resumed;
  n.facts.afterLive = JSON.stringify(resumed.session.snapshot().live?.pending ?? null);
  n.facts.resumedView = resumed.session.advanceGame(); // the restored game surfaces its waiting decision
});

Then("the same exit interview is waiting with the same options", function (this: BbWorld) {
  const n = this.night!;
  const view = n.facts.resumedView as AdvanceView;
  assert.equal(view.pending?.kind, "exit-interview", "the restored game stands at the exit interview");
  assert.equal(view.pending?.kind, n.pending!.kind);
  assert.equal(view.pending?.evictee?.id, PLAYER, "the player is still the evictee being interviewed");
  assert.deepEqual(view.pending?.options.map((o) => o.id), n.pending!.options.map((o) => o.id), "the same postures are offered");
  assert.deepEqual(view.pending?.stances, n.pending!.stances);
  assert.ok((view.pending?.options.length ?? 0) > 0, "there are postures to choose from");
  assert.equal(n.facts.afterLive, n.facts.beforeLive, "the engine state holds the identical pending after the restart");
  assert.equal(view.eviction?.stage, "exit-interview", "the night is still staged at the interview");
  assert.ok(!(view.event), "no beat fired for the player on the way back in");
});

Then("answering it completes the night", function (this: BbWorld) {
  const n = this.night!;
  const resumed = n.facts.resumed as ReturnType<typeof resumeFrom>;
  const s = resumed.session;
  s.submitDecision({ kind: "exit-interview", vote: "defiant", statement: "not done" } as SubmitDecisionReq);
  const mine = (s.snapshot().live?.exitInterviews ?? []).find((x) => x.evictee === PLAYER);
  assert.equal(mine?.stance, "defiant", "the player's posture was recorded after the restart");
  assert.equal(mine?.message, "not done");
  const seen: string[] = [];
  const done = advanceUntil(resumed, (v) => { if (v.event) seen.push(v.event.beat); return v.event?.beat === "eviction-result"; }, 20);
  assert.ok(done, `the night reached its result after the restart (saw ${seen.join(" -> ")})`);
  assert.equal(done.eviction ?? null, null, "the eviction projection is gone once the result lands");
  assert.equal(s.snapshot().live?.eviction, undefined, "the eviction sub-loop is cleared");
});
