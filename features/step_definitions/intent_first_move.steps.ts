import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../support/answerPending";
import type { ResolvePlayerMoveResult } from "../../src/ports/GameSession";

/**
 * ORW-419 (Ryne 2026-11-15: "the engine should move before the narrator") - feature 0049. The engine resolves the player's own move from
 * their words (resolvePlayerMove, the call the front end makes BEFORE the narrator round) and hands the narrator the recorded from/to.
 * Drives the real adapter; roles only.
 */
type Bag = { s?: GameSessionAdapter; r?: ResolvePlayerMoveResult; before?: { room: string; clock: string } };
const bag = (w: unknown): Bag => ((w as { move419?: Bag }).move419 ??= {});
const ROOM: Record<string, string> = { "the kitchen": "kitchen", "the backyard": "backyard", "the living room": "living-room" };
const live = (s: GameSessionAdapter) => (s as unknown as { live: Record<string, unknown> }).live; // a TEST-ONLY seam, as in tests/unit/resolvePlayerMove.test.ts
let n = 0;

Given("a started game with the player in the backyard and no house event in session", function () {
  const s = new GameSessionRegistry().sandboxFor(`move419-${n++}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "The Player", seed: 21 });
  live(s).champagneCircle = undefined; // the premiere's gathered toast is a house event; a real game is past it
  s.movePlayer("backyard");
  assert.equal(s.whereabouts()!.room, "backyard");
  bag(this).s = s;
});

Given(/^a seeded season paused at (an eviction vote|a competition in session)$/, function (event: string) {
  const want = (s: GameSessionAdapter): boolean => {
    const k = s.getGameState().pending?.kind;
    return event === "an eviction vote" ? k === "eviction-vote" : k === "comp-intent" || k === "comp-round";
  };
  GameSessionAdapter.setTimeOfDayEnabled(true); // the in-game clock must be RUNNING so "the clock is unchanged" is a real check (restored by features/support/resetStaticOverrides.ts after the scenario)
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`move419-ev-${n++}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "The Player", seed });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (want(s)) { bag(this).s = s; return; }
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error(`no seed reached ${event}`);
});

When("the engine reads the player's words {string}", function (text: string) {
  const b = bag(this); const s = b.s!;
  b.before = { room: s.whereabouts()!.room, clock: JSON.stringify([live(s).nightDepth, live(s).timeOfDay]) };
  b.r = s.resolvePlayerMove({ text });
});

Then(/^the engine has the player in (the kitchen|the backyard|the living room)$/, function (room: string) {
  assert.equal(bag(this).s!.whereabouts()!.room, ROOM[room]);
});

Then(/^the game state hands the narrator the move from (the \w+(?: \w+)?) to (the \w+(?: \w+)?)$/, function (from: string, to: string) {
  const s = bag(this).s!;
  // ORW-1138: the move also names who stayed or came along; from and to are the contract here.
  for (const pm of [bag(this).r!.playerMove, s.getGameState().playerMove]) {
    assert.ok(pm, "the narrator's view does not carry the move");
    assert.deepEqual({ from: pm!.from, to: pm!.to }, { from: ROOM[from], to: ROOM[to] });
  }
});

Then("the game state hands the narrator no move", function () {
  const s = bag(this).s!;
  assert.equal(bag(this).r!.playerMove, null);
  assert.ok(!s.getGameState().playerMove, "a move reached the narrator's view");
});

Then("the move is refused with an in-fiction reason", function () {
  const pm = bag(this).r!.playerMove as { refused?: boolean; reason?: string } | null;
  assert.ok(pm && pm.refused === true, `the move was not refused: ${JSON.stringify(pm)}`);
  assert.ok((pm.reason ?? "").length > 5 && !/\d/.test(pm.reason ?? ""), "no in-fiction reason (or a number in it)");
  assert.deepEqual(bag(this).s!.getGameState().playerMove, pm, "the refusal does not reach the narrator's game-state view"); // review of #2760
});

Then("the player's room and the in-game clock are unchanged", function () {
  const b = bag(this); const s = b.s!;
  assert.equal(s.whereabouts()!.room, b.before!.room);
  assert.equal(JSON.stringify([live(s).nightDepth, live(s).timeOfDay]), b.before!.clock);
  assert.notEqual(b.before!.clock, "[null,null]", "the in-game clock was not running, so 'unchanged' proved nothing"); // review of #2760
});
