import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../support/answerPending";

// Feature 0205 (ORW-653). Roles only. Real played sandboxes.
type Live = { premiereEntrance?: { stage: string; order: string[]; arrived: number; introduced?: string[] } };
const pe = (x: GameSessionAdapter) => (x as unknown as { live: Live }).live.premiereEntrance!;
let n = 0;
let s: GameSessionAdapter;
const open = (seed: number, on: boolean): GameSessionAdapter => {
  const x = new GameSessionRegistry().sandboxFor(`meet-bdd-${n++}`).session as GameSessionAdapter;
  x.setPremiereEntrancesEnabled(true); x.setBedRushEnabled(true); x.setHouseTourEnabled(true); x.setMeetTheCastEnabled(on);
  x.createCharacter({ playerName: "P", seed });
  x.noteMessage({ messageId: "m1" });
  return x;
};
const step = (x: GameSessionAdapter): void => { const v = x.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void x.submitDecision(req)); };

Given("meet the cast: a played premiere", function () { s = open(7, true); });
Given("meet the cast: a played premiere with the flag off", function () { s = open(7, false); });
Then("meet the cast: no introduction is recorded through the entrances and the tour and the record opens when the circle is called", function () {
  for (let i = 0; i < 30 && pe(s).arrived < pe(s).order.length; i++) { step(s); assert.equal(pe(s).introduced, undefined); }
  step(s);
  assert.equal(pe(s).stage, "toast");
  assert.deepEqual(pe(s).introduced, []);
});
Then("meet the cast: the circle introduces every houseguest exactly once and marks them met", function () {
  for (let i = 0; i < 30 && pe(s).stage !== "toast"; i++) step(s);
  for (let i = 0; i < 30 && pe(s).stage === "toast"; i++) step(s);
  const intro = pe(s).introduced!;
  assert.equal(new Set(intro).size, intro.length);
  assert.deepEqual([...intro].sort(), [...pe(s).order].sort());
});
Then("meet the cast: the same seed gives the same hidden reads and the narrator facts carry no number", function () {
  const a = open(9, true), b = open(9, true);
  const shown: string[] = [];
  for (const x of [a, b]) for (let i = 0; i < 60 && pe(x).stage !== "done"; i++) { step(x); if (x === a) shown.push(JSON.stringify(a.premiereIntros()?.entrance ?? {})); }
  assert.deepEqual(pe(a).introduced, pe(b).introduced);
  assert.doesNotMatch(shown.join(""), /affinity|trust|threat|lean/);
});
Then("meet the cast: no introduction record or manner exists", function () {
  for (let i = 0; i < 40 && pe(s).stage !== "done"; i++) { step(s); assert.equal(pe(s).introduced, undefined); }
});
