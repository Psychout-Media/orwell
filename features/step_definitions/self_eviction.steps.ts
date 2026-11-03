import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { resolvePending } from "../support/answerPending";

// Feature 0061 — player self-eviction (the voluntary walk-out / quit path). Driven through the live
// MCP seam (createCharacter → requestSelfEviction / submitDecision). Owner decisions baked in:
// (1) a confirmed quit FORFEITS — exit entirely, terminal, never a juror's seat, in any phase;
// (2) the parting message is offered-but-skippable; (3) legal at any beat. HARD rule: roles only.

let svUsers = 0;

/** A deterministic player policy for the auto-driven beats (compete, first legal options, no veto). */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  resolvePending(p, (req) => s.submitDecision(req)); // `self-evict` is intentionally never auto-answered (it returns null)
}

const playerLeft = (s: GameSessionAdapter): boolean => (s.snapshot().live?.evictionOrder ?? []).includes(PLAYER);

function newGame(w: BbWorld, seed: number): UserSandbox {
  const reg = new GameSessionRegistry();
  const user = `sv${svUsers++}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  w.svRegistry = reg; w.svUser = user; w.svSandbox = sb;
  return sb;
}

/** Advance a handful of beats so the season is live but keep the PLAYER active. */
function driveLiveButActive(s: GameSessionAdapter, beats: number): void {
  for (let i = 0; i < beats; i++) {
    if (playerLeft(s)) return;
    const v = s.advanceGame();
    if (v.pending && v.pending.kind !== "self-evict") resolve(s, v.pending);
    if (v.finished) return;
  }
}

/** A fresh game advanced a few beats with the player still active (pre-jury). */
function activeMidGame(w: BbWorld, beats: number): UserSandbox {
  for (let seed = 1; seed <= 40; seed++) {
    const sb = newGame(w, seed);
    driveLiveButActive(sb.session, beats);
    if (!playerLeft(sb.session) && !sb.session.snapshot().live?.finished) return sb;
  }
  throw new Error("no seed kept the player active for the wanted run");
}

/** Drive deep enough that an ordinary eviction would seat a juror (index ≥ pre-jury), player still active. */
function activeJuryWindow(w: BbWorld): UserSandbox {
  for (let seed = 1; seed <= 60; seed++) {
    const sb = newGame(w, seed);
    for (let i = 0; i < 4000; i++) {
      const v = sb.session.advanceGame();
      if (v.pending && v.pending.kind !== "self-evict") resolve(sb.session, v.pending);
      if (v.finished || playerLeft(sb.session)) break;
      const live = sb.session.snapshot().live!;
      const cast = sb.session.getGameState().house.length + 1;
      const preJury = Math.max(0, cast - 2 - 9);
      if (live.evictionOrder.length >= preJury && live.active.includes(PLAYER) && live.active.length > 2) return sb;
    }
  }
  throw new Error("no seed reached the jury window with the player still active");
}

const present = (sb: UserSandbox): EntityId[] =>
  sb.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id);

// --- Given: states ------------------------------------------------------------

Given("a started game in which the player is active before the jury", function (this: BbWorld) {
  activeMidGame(this, 4);
});

Given("a started game in which the player is active", function (this: BbWorld) {
  activeMidGame(this, 6);
});

Given("a started game in which the player is active during the jury phase", function (this: BbWorld) {
  activeJuryWindow(this);
});

Given("the player has confirmed an explicit, OOC self-eviction decision", function (this: BbWorld) {
  // Step 1 of the handshake: the OOC intent raises the confirmation (no state change yet).
  this.svSandbox!.session.requestSelfEviction();
});

Given("a self-eviction confirmation decision is pending", function (this: BbWorld) {
  this.svSandbox!.session.requestSelfEviction();
  this.svStateBefore = JSON.stringify(this.svSandbox!.session.snapshot().live);
});

Given("a started game with a Vault sentinel planted in the hidden layer", function (this: BbWorld) {
  const sb = activeMidGame(this, 6);
  this.svSentinel = "SENTINEL-0061-selfevict-hidden";
  sb.engine.events.record({
    id: "sv:hidden", ts: 9_500_000, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: this.svSentinel,
  });
  sb.engine.vault.writeHidden({ id: "sv:vault", kind: "confessional", content: this.svSentinel });
});

Given("no self-eviction event has been recorded", function (this: BbWorld) {
  // No requestSelfEviction / no confirmed submit — nothing recorded by construction.
  assert.equal(playerLeft(this.svSandbox!.session), false);
});

// --- When: actions ------------------------------------------------------------

When("the confirmed self-eviction is submitted through the validated decision seam", function (this: BbWorld) {
  const sb = this.svSandbox!;
  this.svWitnessedBefore = sb.engine.events.query({ witnessedBy: PLAYER }).length;
  this.svPresent = present(sb);
  this.svView = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
});

When("the player completes a confirmed self-eviction", function (this: BbWorld) {
  const sb = this.svSandbox!;
  this.svPresent = present(sb);
  sb.session.requestSelfEviction();
  this.svView = sb.session.submitDecision({ kind: "self-evict", confirmed: true });
});

When("the player expresses a bare, ambiguous intent to leave", function (this: BbWorld) {
  const sb = this.svSandbox!;
  this.svEventsBefore = sb.engine.events.queryAll().length;
  // A bare OOC intent — it raises the confirmation, never an eviction (the L36/L39a gate holds).
  this.svView = sb.session.requestSelfEviction();
});

When("the player cancels the confirmation", function (this: BbWorld) {
  this.svView = this.svSandbox!.session.cancelSelfEviction();
});

When("the player's projection is read", function (this: BbWorld) {
  this.svGameState = this.svSandbox!.session.getGameState();
});

// --- Then: assertions ---------------------------------------------------------

Then("a self-eviction event is recorded with the player in its witness set", function (this: BbWorld) {
  const sb = this.svSandbox!;
  const witnessed = sb.engine.events.query({ witnessedBy: PLAYER });
  assert.ok(witnessed.length > (this.svWitnessedBefore ?? 0), "a new witnessed event was recorded");
  const exit = witnessed.find((e) => /self-evict/i.test(e.content));
  assert.ok(exit, "a self-eviction event is recorded");
  assert.ok(exit!.witnessSet.includes(PLAYER), "the player is in the witness set");
});

Then("the recorded event is not hidden", function (this: BbWorld) {
  const exit = this.svSandbox!.engine.events.queryAll().find((e) => /self-evict/i.test(e.content));
  assert.ok(exit, "the self-eviction event exists");
  assert.equal(exit!.hidden, false, "the self-eviction event is not hidden");
});

Then("the event folds its hidden impact into the relationship and soul layer", function (this: BbWorld) {
  // The 0023 fold runs in the commit path on the recorded beat (the present house's read of the
  // leaver moves). It is HIDDEN by construction (a later scenario proves no number crosses); here we
  // assert the consequential beat genuinely fired so the fold ran.
  assert.equal(this.svView!.event?.beat, "self-eviction", "the consequential self-eviction beat fired");
});

Then("the player's status transitions out through the same sanctioned player-exit door as a vote-out", function (this: BbWorld) {
  const sb = this.svSandbox!;
  // The SAME door a vote-out uses: the player lands in `evictionOrder` and the seat flips out.
  assert.ok(playerLeft(sb.session), "the player went out through the evictionOrder door (the 0046 hinge)");
  assert.notEqual(sb.session.getGameState().player?.status, "active");
});

Then("the transition persists and survives an engine restart", function (this: BbWorld) {
  const user = this.svUser!;
  const before = this.svRegistry!.sandboxFor(user).session.getGameState().player?.status;
  const snap = this.svRegistry!.snapshot(user);
  const reg2 = new GameSessionRegistry();
  reg2.restore(user, snap);
  const after = reg2.sandboxFor(user).session.getGameState().player?.status;
  assert.equal(after, before, "the out-of-game status resumes after a restart");
  assert.notEqual(after, "active", "the player is still marked out after the restart");
});

Then("a self-eviction confirmation decision is surfaced on the player-level OOC channel", function (this: BbWorld) {
  const sb = this.svSandbox!;
  const onView = this.svView?.pending?.kind === "self-evict";
  const onStatus = sb.session.gameStatus().pending?.kind === "self-evict";
  assert.ok(onView || onStatus, "the self-evict confirmation is surfaced on the player-level channel");
});

Then("no self-eviction event is recorded", function (this: BbWorld) {
  const sb = this.svSandbox!;
  assert.equal(sb.engine.events.queryAll().length, this.svEventsBefore ?? sb.engine.events.queryAll().length,
    "no new event was recorded by the bare intent");
  assert.ok(!sb.engine.events.queryAll().some((e) => /self-evict/i.test(e.content)), "no self-eviction event exists");
});

Then("the player's status is still active", function (this: BbWorld) {
  assert.equal(this.svSandbox!.session.getGameState().player?.status, "active");
});

Then("the house neither hears nor reacts to the out-of-character intent", function (this: BbWorld) {
  const sb = this.svSandbox!;
  // The OOC intent is NOT a recorded in-game event — no houseguest witnessed it, nothing folded.
  assert.ok(!sb.engine.events.queryAll().some((e) => /self-evict/i.test(e.content)), "the house has no record of the intent");
  assert.equal(playerLeft(sb.session), false, "the player is still in the house");
});

Then("the player remains active and in the house", function (this: BbWorld) {
  const sb = this.svSandbox!;
  assert.equal(sb.session.getGameState().player?.status, "active");
  assert.equal(playerLeft(sb.session), false);
});

// `the game state is unchanged` (cancel) + `the player's status is marked evicted` are SHARED steps
// (agent_play_loop / player_eviction) made cross-feature aware via `this.svSandbox` — not redefined here.

Then("the season reaches a defined terminal end state for that player", function (this: BbWorld) {
  const sb = this.svSandbox!;
  // The player's game is over: the terminal walk-out moment + the 0048 retrospective gate opens.
  assert.equal(sb.session.getGameState().moment, "self-evicted");
  assert.equal(sb.session.snapshot().live?.finished, true);
  assert.notEqual(sb.session.seasonRetrospective(), null, "the terminal retrospective gate opens");
});

Then("the player's exit resolves through the 0046 player-exit machinery", function (this: BbWorld) {
  const sb = this.svSandbox!;
  // The 0046 door: the player is in evictionOrder and the seat read is out — never a new hinge.
  assert.ok(playerLeft(sb.session), "the player exited through the evictionOrder door");
  // Owner decision #1: a quit FORFEITS — even in the jury window, the seat reads evicted, never jury.
  assert.equal(sb.session.getGameState().player?.status, "evicted");
});

Then("the resolution uses no new eviction or restart path", function (this: BbWorld) {
  const sb = this.svSandbox!;
  // No second exit/restart hinge: the player rode the same evictionOrder removal, the season is the
  // SAME live season (a restart would have rotated to a fresh one — the user key is unchanged), and
  // no juror seat was created (the forfeit, owner decision #1).
  assert.equal(this.svView!.event?.beat, "self-eviction");
  assert.equal(sb.session.finaleView(), null, "no juror seat / finale path was created");
  assert.ok(playerLeft(sb.session));
});

Then("the departure satisfies the daily-event invariant for that in-game day", function (this: BbWorld) {
  // A significant, recorded house event lands on the player's day (≥1 meaningful event, 0008).
  const exit = this.svSandbox!.engine.events.query({ witnessedBy: PLAYER }).find((e) => /self-evict/i.test(e.content));
  assert.ok(exit, "the departure is a recorded meaningful event for the day");
  assert.equal(exit!.hidden, false);
});

Then("the houseguests present witness the departure", function (this: BbWorld) {
  const exit = this.svSandbox!.engine.events.query({ witnessedBy: PLAYER }).find((e) => /self-evict/i.test(e.content));
  assert.ok(exit, "the self-eviction event exists");
  const present = this.svPresent ?? [];
  assert.ok(present.length > 0, "there was a present house to witness");
  assert.ok(present.every((id) => exit!.witnessSet.includes(id)), "the present house is in the witness set");
});

Then("the houseguests' souls fold the exit into their relationship reads", function (this: BbWorld) {
  // The fold ran in the commit path on the consequential self-eviction beat (hidden by construction).
  assert.equal(this.svView!.event?.beat, "self-eviction", "the consequential beat that folds souls fired");
});

Then("the player is offered the chance to author their own parting message", function (this: BbWorld) {
  // Offered-but-skippable (owner decision #2): the confirmed submit accepts the player's OWN parting
  // words (relayed as `statement`) AND finalizes whether or not they author one — the engine never
  // speaks for them. Prove BOTH paths reach the terminal exit on a fresh run.
  const w = this as BbWorld;
  const skip = activeMidGame(w, 6);
  skip.session.requestSelfEviction();
  skip.session.submitDecision({ kind: "self-evict", confirmed: true });
  assert.equal(skip.session.getGameState().player?.status, "evicted", "a skipped parting message still finalizes");

  const author = activeMidGame(w, 6);
  author.session.requestSelfEviction();
  const v = author.session.submitDecision({ kind: "self-evict", confirmed: true, statement: "Thank you all." });
  assert.equal(author.session.getGameState().player?.status, "evicted", "an authored parting message still finalizes");
  assert.equal(v.event?.beat, "self-eviction");
});

Then("the sentinel never appears on the self-eviction confirmation pending", function (this: BbWorld) {
  const v = this.svSandbox!.session.requestSelfEviction();
  assert.ok(!JSON.stringify(v).includes(this.svSentinel!), "no sentinel on the confirmation pending");
  assert.ok(!JSON.stringify(this.svSandbox!.session.gameStatus()).includes(this.svSentinel!), "no sentinel on the status pending");
});

Then("the sentinel never appears on the decision-seam output", function (this: BbWorld) {
  const out = this.svSandbox!.session.submitDecision({ kind: "self-evict", confirmed: true });
  this.svView = out;
  assert.ok(!JSON.stringify(out).includes(this.svSentinel!), "no sentinel on the submitDecision output");
});

Then("the sentinel never appears on the post-exit player projection or recap", function (this: BbWorld) {
  const sb = this.svSandbox!;
  assert.ok(!JSON.stringify(sb.session.getGameState()).includes(this.svSentinel!), "no sentinel on the projection");
  assert.ok(!JSON.stringify(sb.session.seasonRecap()).includes(this.svSentinel!), "no sentinel on the recap");
  assert.ok(!JSON.stringify(sb.session.getMomentPrompt({})).includes(this.svSentinel!), "no sentinel on the moment prompt");
});

Then("the sentinel never appears on the admin surface", function (this: BbWorld) {
  const sb = this.svSandbox!;
  sb.syncAdmin();
  const blob = JSON.stringify(sb.admin.inspect()) + JSON.stringify(sb.admin.health());
  assert.ok(!blob.includes(this.svSentinel!), "no sentinel on the admin surface (the Wall walls admin too)");
});

Then("the player is still in the house", function (this: BbWorld) {
  assert.equal(playerLeft(this.svSandbox!.session), false);
  assert.equal((this.svGameState ?? this.svSandbox!.session.getGameState()).player?.status, "active");
});
