import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { isCommonArea } from "../../src/engine/houseTour";
import { resolvePending } from "../support/answerPending";

// Feature 0206 (ORW-654). Roles only. Real played sandboxes; the tour runs on advanceGame and movePlayer.
type Live = { premiereEntrance?: { stage: string; order: string[]; arrived: number; playerPos: number }; houseTour?: { seen: string[] }; champagneCircle?: string; beds?: { owner: Record<string, string>; claims: Array<{ who: string }> }; bedRush?: { done: boolean; windowEnded?: boolean } };
const liveOf = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
let n = 0;
let s: GameSessionAdapter;
let many: GameSessionAdapter[] = [];
const open = (seed: number, tour: boolean): GameSessionAdapter => {
  const x = new GameSessionRegistry().sandboxFor(`tour-bdd-${n++}`).session as GameSessionAdapter;
  x.setPremiereEntrancesEnabled(true); x.setBedRushEnabled(true); x.setHouseTourEnabled(tour);
  x.createCharacter({ playerName: "P", seed });
  x.noteMessage({ messageId: "m1" });
  return x;
};
const step = (x: GameSessionAdapter): void => { const v = x.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void x.submitDecision(req)); };
const pe = (x: GameSessionAdapter) => liveOf(x).premiereEntrance!;
const walkedIn = (x: GameSessionAdapter): void => { for (let i = 0; i < 20 && pe(x).arrived <= pe(x).playerPos; i++) step(x); };
const everyoneIn = (x: GameSessionAdapter): void => { for (let i = 0; i < 20 && pe(x).arrived < pe(x).order.length; i++) step(x); };

Given("tour: a played premiere where the player has not yet walked in", function () {
  s = open(3, true);
  for (const seed of [3, 5, 7, 9, 11, 13, 17, 19]) { s = open(seed, true); if (pe(s).playerPos >= 2) break; }
});
Then("tour: a move is refused until the player's own entrance and allowed after it", function () {
  const before = s.whereabouts()!.room;
  s.movePlayer("kitchen");
  assert.equal(s.whereabouts()!.room, before);
  walkedIn(s);
  s.movePlayer("kitchen");
  assert.equal(s.whereabouts()!.room, "kitchen");
});
Given("tour: a played premiere with everyone inside", function () { s = open(7, true); everyoneIn(s); });
Then("tour: the next advance calls the circle and the player is in the living room", function () {
  assert.equal(pe(s).stage, "entrances");
  s.movePlayer("backyard");
  step(s);
  assert.equal(pe(s).stage, "toast");
  assert.equal(liveOf(s).champagneCircle, "gathered");
  assert.equal(s.whereabouts()!.room, "living-room");
});
Given("tour: several played premieres with everyone inside", function () { many = [2, 4, 6, 8, 10, 12].map((seed) => { const x = open(seed, true); everyoneIn(x); return x; }); });
Then("tour: most houseguests stand in the common area and only a bounded few are elsewhere", function () {
  let out = 0, all = 0;
  for (const x of many) for (const [id, room] of (x as unknown as { presence: Map<string, string> }).presence) { if (id === "player") continue; all++; if (!isCommonArea(room as never)) out++; }
  assert.ok(out / all < 0.5, "most are in the common area");
  assert.ok(out > 0, "a few wander");
});
Given("tour: a played premiere with the player inside", function () { s = open(7, true); walkedIn(s); });
Then("tour: the first entry into a room hands over a card once and a second entry does not", function () {
  s.movePlayer("kitchen");
  assert.equal(s.whereabouts()!.roomCard?.room, "kitchen");
  s.noteMessage({ messageId: "m2" });
  s.movePlayer("living-room");
  s.noteMessage({ messageId: "m3" });
  s.movePlayer("kitchen");
  assert.equal(s.whereabouts()!.roomCard, undefined);
});
Given("tour: a played premiere run through the tour and the bed rush", function () {
  s = open(11, true);
  for (let i = 0; i < 80 && pe(s).stage !== "done"; i++) { step(s); assert.equal(liveOf(s).beds?.claims.length ?? 0, 0); }
  for (let i = 0; i < 12 && !liveOf(s).bedRush?.done && !liveOf(s).bedRush?.windowEnded; i++) step(s);
  (s as unknown as { bedThePlayer(): void }).bedThePlayer();
});
Then("tour: no bed is claimed on the tour and sixteen distinct beds end owned", function () {
  const owners = Object.values(liveOf(s).beds!.owner);
  assert.equal(owners.length, 16);
  assert.equal(new Set(owners).size, 16);
});
Given("tour: a played premiere with the tour off", function () { s = open(7, false); });
Then("tour: the player is held through the entrances and no tour record is saved", function () {
  assert.equal(liveOf(s).houseTour, undefined);
  for (let i = 0; i < 20 && pe(s).stage === "entrances"; i++) {
    const before = s.whereabouts()!.room;
    s.movePlayer("kitchen");
    assert.equal(s.whereabouts()!.room, before);
    step(s);
  }
  assert.equal(pe(s).stage, "toast");
});
