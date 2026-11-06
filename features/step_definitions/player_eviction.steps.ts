import { Given, When, Then } from "@cucumber/cucumber";
import { pinLayersOff } from "../support/pinLayersOff";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER } from "../../src/domain/ids";
import { answerPending, resolvePending } from "../support/answerPending";

// Feature 0046 — player eviction & the juror's seat. Driven through the live MCP seam
// (createCharacter → advanceGame/submitDecision). HARD rule: roles only — no names.

/** A simple, deterministic player policy: compete, take the first legal options, never use the veto. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => void s.submitDecision(req));
}

const evictionOrder = (s: GameSessionAdapter): string[] => s.snapshot().live?.evictionOrder ?? [];
const playerIdx = (s: GameSessionAdapter): number => evictionOrder(s).indexOf(PLAYER);

/** Advance until the player is evicted (returns the index) or the game finishes. */
function driveToPlayerEviction(s: GameSessionAdapter): { idx: number; finished: boolean } {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (playerIdx(s) >= 0) return { idx: playerIdx(s), finished: v.finished };
    if (v.finished) return { idx: -1, finished: true };
  }
  throw new Error("game did not resolve");
}

let peUsers = 0;
/** Start games until one evicts the player into an index the predicate accepts; stash it on the world. */
function seedEvicting(w: BbWorld, inRange: (idx: number) => boolean, bound = 40): UserSandbox {
  for (let seed = 1; seed <= bound; seed++) {
    const reg = new GameSessionRegistry();
    const user = `pe${peUsers++}`;
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "P", seed });
    pinLayersOff(sb.session); // the seed search for the wanted eviction index is a flag-off-profile premise
    if (inRange(driveToPlayerEviction(sb.session).idx)) {
      w.peRegistry = reg; w.peUser = user; w.peSandbox = sb;
      return sb;
    }
  }
  throw new Error("no seed evicted the player into the wanted range within the bound");
}

// The jury is the last 9 of the (cast − 2) evictions; with the 16-cast that is eviction index ≥ 5.
const PRE_JURY = (i: number): boolean => i >= 0 && i < 5;
const JURY = (i: number): boolean => i >= 5;

function playToEnd(s: GameSessionAdapter): { finished: boolean } {
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return { finished: true };
  }
  return { finished: false };
}

// --- Scenario: a pre-jury eviction reaches a defined end -----------------------

Given("a started game in which the player is evicted before the jury", function (this: BbWorld) {
  seedEvicting(this, PRE_JURY);
});

When("the eviction resolves", function (this: BbWorld) {
  // The player is already evicted (the Given drove there); capture the projection at this moment.
  this.peView = this.peSandbox!.session.getGameState();
});

// Shared by 0046 (vote-out) and 0061 (self-eviction): read whichever feature's sandbox/view is live.
Then("the player's status is marked evicted", function (this: BbWorld) {
  const status = this.svSandbox
    ? this.svSandbox.session.getGameState().player!.status
    : this.peView!.player!.status;
  assert.equal(status, "evicted");
});

Then("the player's decisions after the eviction are the exit interview, then the spectator choice", function (this: BbWorld) {
  // The evicted player is never left with "nothing": the ORDERED chain of decisions raised after the eviction resolves is the 0130 exit
  // interview, THEN the 0133 spectator-choice card. Advance, answering each, and record the kinds in order.
  const s = this.peSandbox!.session;
  const kinds: string[] = [];
  let pending = s.getGameState().pending;
  for (let i = 0; i < 12 && kinds[kinds.length - 1] !== "spectator-choice"; i++) {
    if (!pending) pending = s.advanceGame().pending;
    if (!pending) continue;
    kinds.push(pending.kind);
    if (pending.kind === "spectator-choice") break;
    resolve(s, pending);
    pending = undefined as never;
  }
  assert.deepEqual(kinds.slice(0, 2), ["exit-interview", "spectator-choice"], `ordered chain after the eviction, got ${kinds.join(" → ")}`);
});

Then("the season reaches a defined end state for that player", function (this: BbWorld) {
  // A pre-jury player holds no power and casts no vote; the loop still runs to a crowned winner.
  const s = this.peSandbox!.session;
  assert.equal(playToEnd(s).finished, true);
  const live = s.snapshot().live!;
  assert.ok(live.winner, "a winner was crowned");
  assert.notEqual(live.winner, PLAYER, "the evicted player is not the winner");
});

// --- Scenario: a jury-phase eviction seats the player on the jury ---------------

Given("a started game in which the player is evicted into the jury", function (this: BbWorld) {
  seedEvicting(this, JURY);
});

Then("the player's status is marked jury", function (this: BbWorld) {
  assert.equal(this.peView!.player!.status, "jury");
});

Then("the moment framing switches to the spectator\\/jury view", function (this: BbWorld) {
  assert.equal(this.peView!.moment, "jury");
});

// --- Scenario: a juror only learns public ceremony outcomes --------------------

Given("the player is a juror while the house plays on", function (this: BbWorld) {
  const sb = seedEvicting(this, (i) => i >= 5 && i <= 10); // mid-jury: ceremonies remain to broadcast
  this.peWitnessedAtEviction = sb.engine.events.query({ witnessedBy: PLAYER }).length;
  for (let k = 0; k < 8; k++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolve(sb.session, v.pending);
    if (v.finished) break;
  }
});

Given("the house schemes off-screen and records confessionals the player did not witness", function (this: BbWorld) {
  // The live ceremonies already record NPC confessionals (hidden, witness excludes the player). Add an
  // explicit off-screen scheme carrying a unique sentinel so we can prove it never reaches the juror.
  const sb = this.peSandbox!;
  this.peSentinel = "SENTINEL-0046-offscreen-scheme";
  const npcs = sb.session.getGameState().house;
  sb.engine.events.record({
    id: "hidden:0046-bdd", ts: 10_000_001, type: "conversation",
    initiator: npcs[0]!.id, witnessSet: [npcs[0]!.id, npcs[1]!.id], hidden: true, content: this.peSentinel,
  });
  const hidden = sb.engine.events.queryAll().filter((e) => e.hidden);
  assert.ok(hidden.length > 0, "the house has a hidden life");
  assert.ok(hidden.every((e) => !e.witnessSet.includes(PLAYER)), "no hidden event lists the player as a witness");
});

When("the juror's knowledge is derived", function (this: BbWorld) {
  this.peView = this.peSandbox!.session.getGameState();
});

Then("it contains only the public ceremony outcomes broadcast after their eviction", function (this: BbWorld) {
  const sb = this.peSandbox!;
  const witnessed = sb.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(witnessed.length > (this.peWitnessedAtEviction ?? 0), "the broadcasts kept coming from the jury box");
  // Everything that arrived AFTER the eviction is a PUBLIC ceremony broadcast (a non-hidden house-event). Earlier events are the
  // player's own in-house knowledge (e.g. an NPC deal offer made while they still played) and are not this claim's subject.
  const fromTheBox = witnessed.slice(this.peWitnessedAtEviction ?? 0);
  assert.ok(
    fromTheBox.every((e) => e.type === "house-event" && e.hidden === false),
    "only public broadcasts after the eviction: " + JSON.stringify(fromTheBox.filter((e) => !(e.type === "house-event" && e.hidden === false)).map((e) => e.content)),
  );
});

Then("it contains no off-screen scheme and no confessional", function (this: BbWorld) {
  const sb = this.peSandbox!;
  const witnessed = sb.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(!witnessed.some((e) => e.type === "confessional"), "no confessional reaches the juror");
  assert.ok(!witnessed.some((e) => e.content.includes(this.peSentinel!)), "no off-screen scheme reaches the juror");
});

Then("no Vault sentinel value appears on the juror's projection", function (this: BbWorld) {
  const sb = this.peSandbox!;
  const surface = [
    JSON.stringify(this.peView),
    sb.engine.events.query({ witnessedBy: PLAYER }).map((e) => e.content).join("\n"),
  ].join("\n");
  assert.ok(!surface.includes(this.peSentinel!), "the Vault sentinel never crosses to the juror");
});

// --- Scenario: the juror watches to the finale and casts a vote ----------------

Given("the player is a juror", function (this: BbWorld) {
  seedEvicting(this, JURY);
});

When("the remaining weeks are fast-forwarded to the finale", function (this: BbWorld) {
  const s = this.peSandbox!.session;
  this.peSawJurorVote = false;
  for (let i = 0; i < 8000; i++) {
    const v = s.advanceGame();
    if (v.pending?.kind === "juror-vote") this.peSawJurorVote = true;
    if (v.pending) resolve(s, v.pending);
    if (v.finished) break;
  }
});

Then("the player is brought to the finale as a juror", function (this: BbWorld) {
  assert.equal(this.peSawJurorVote, true, "the finale stopped for the player's own juror vote");
});

Then("the player casts a juror vote through the validated seam", function (this: BbWorld) {
  const live = this.peSandbox!.session.snapshot().live!;
  assert.equal(live.finished, true, "the finale resolved");
  assert.ok(live.finale?.votes?.[PLAYER], "the player's own juror vote was recorded");
});

// --- Scenario: a player evicted at any index completes the season --------------

Given("a seeded game in which the player is evicted at an arbitrary week", function (this: BbWorld) {
  seedEvicting(this, (i) => i >= 0); // any index — the player simply gets voted out
});

When("the season runs to completion", function (this: BbWorld) {
  assert.equal(playToEnd(this.peSandbox!.session).finished, true);
});

Then("it reaches a winner or the player's defined end state without error", function (this: BbWorld) {
  const live = this.peSandbox!.session.snapshot().live!;
  assert.ok(live.winner, "a winner was crowned");
  assert.equal(live.active.length, 2, "the season reached Final 2");
});

Then("the out-of-game state survives an engine restart", function (this: BbWorld) {
  const user = this.peUser!;
  const statusBefore = this.peRegistry!.sandboxFor(user).session.getGameState().player!.status;
  const snap = this.peRegistry!.snapshot(user);
  const reg2 = new GameSessionRegistry();
  reg2.restore(user, snap);
  const statusAfter = reg2.sandboxFor(user).session.getGameState().player!.status;
  assert.equal(statusAfter, statusBefore, "the out-of-game status resumes after a restart");
  assert.notEqual(statusAfter, "active", "the player is still marked out after the restart");
});
