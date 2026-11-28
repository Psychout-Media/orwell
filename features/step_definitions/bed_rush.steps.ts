import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BED_RUSH } from "../../src/engine/bedRush";
import { freeBeds, roomOfBed } from "../../src/engine/beds";
import { resolvePending } from "../support/answerPending";

// Feature 0201 (ORW-672). Roles only. Real played sandboxes; the rush runs one advanceGame per heat.
type Live = { premiereEntrance?: { stage: string }; beds?: { owner: Record<string, string>; claims: Array<{ who: string; why: string }> }; bedRush?: { tick: number; done: boolean; plan: Record<string, { at: number }>; log: Array<{ tick: number; who: string }> } };
const liveOf = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
let n = 0;
let s: GameSessionAdapter;
const open = (seed: number, on: boolean): GameSessionAdapter => {
  const x = new GameSessionRegistry().sandboxFor(`bed-rush-bdd-${n++}`).session as GameSessionAdapter;
  x.setPremiereEntrancesEnabled(true); x.setBedRushEnabled(on);
  x.createCharacter({ playerName: "P", seed });
  x.noteMessage({ messageId: "m1" });
  return x;
};
const step = (x: GameSessionAdapter): void => { const v = x.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void x.submitDecision(req)); };
const closeCircle = (x: GameSessionAdapter, watch?: () => void): void => { for (let i = 0; i < 60 && liveOf(x).premiereEntrance!.stage !== "done"; i++) { step(x); watch?.(); } };

Given("bed rush: a played premiere with the rush on", function () { s = open(7, true); });
Given("bed rush: a played premiere with the circle just closed", function () { s = open(7, true); closeCircle(s); });
Given("bed rush: many seasons where the player hangs back", function () { /* seeds are swept in the step */ });
Given("bed rush: a played premiere where the player rushes to a room", function () { s = open(7, true); closeCircle(s); });
Given("bed rush: a played premiere with the rush off", function () { s = open(7, false); });

Then("bed rush: nobody owns a bed through the entrances and the toast, and the player's own claim is refused", function () {
  s.resolvePlayerMove({ text: "I take a bed in bedroom A" });
  closeCircle(s, () => assert.equal(liveOf(s).beds?.claims.length ?? 0, 0));
  assert.equal(liveOf(s).beds?.owner["player"], undefined);
});
Then("bed rush: a claim from the common area is refused and every houseguest claims only once their arrival tick has come", function () {
  assert.equal((s as unknown as { resolvePlayerBed(t: string): boolean }).resolvePlayerBed("I take a bed in bedroom A"), false);
  for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks && !liveOf(s).bedRush?.done; i++) {
    step(s);
    const br = liveOf(s).bedRush!;
    for (const c of br.log) assert.ok(br.plan[c.who]!.at <= c.tick);
  }
});
Then("bed rush: at every heat at least the floor of beds stays open across at least two rooms", function () {
  for (const seed of [2, 4, 6, 10, 12]) {
    const x = open(seed, true); closeCircle(x);
    for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks; i++) {
      step(x);
      const free = freeBeds(liveOf(x).beds as never, new Set(x.getGameState().house.map((h) => h.id)));
      assert.ok(free.length >= BED_RUSH.floorSpots, `seed ${seed}: ${free.length} open`);
      assert.ok(new Set(free.map((b) => roomOfBed(b))).size >= BED_RUSH.floorRooms, `seed ${seed}: rooms`);
    }
  }
});
Then("bed rush: sixteen distinct beds are owned, nobody claimed twice, and the rush is over within its window", function () {
  s.resolvePlayerMove({ text: "I sprint to bedroom B and take a bed there" });
  for (let i = 0; i < 12 && !liveOf(s).bedRush?.done; i++) step(s);
  const l = liveOf(s);
  assert.equal(l.bedRush!.done, true);
  assert.equal(new Set(Object.values(l.beds!.owner)).size, 16);
  const first = l.beds!.claims.filter((c) => c.why === "move-in");
  assert.equal(new Set(first.map((c) => c.who)).size, first.length);
  assert.ok(l.bedRush!.tick <= BED_RUSH.ticks);
});
Then("bed rush: nobody claims on walking in, the claims run at the close and no rush is saved", function () {
  // ORW-1134: with the rush off nobody claims on walking in either; the claims run once the circle has closed
  closeCircle(s, () => { if (liveOf(s).premiereEntrance!.stage !== "done") assert.equal(liveOf(s).beds?.claims.length ?? 0, 0); });
  (s as unknown as { ensureBeds(): unknown }).ensureBeds();
  assert.ok((liveOf(s).beds?.claims.length ?? 0) > 0);
  assert.equal(liveOf(s).bedRush, undefined);
});
