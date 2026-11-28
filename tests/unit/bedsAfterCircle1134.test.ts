import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BED_RUSH } from "../../src/engine/bedRush";
import { freeBeds, roomOfBed } from "../../src/engine/beds";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-1134 (Ryne 2026-11-28): beds open after the circle. Nobody claims during the entrances or the toast, whatever the rush flag; the first claim is the rush; the player can reach a free bed; everyone is bedded at the end. Roles only. */
type Live = { premiereEntrance?: { stage: string }; beds?: { owner: Record<string, string>; claims: unknown[] }; bedRush?: { done: boolean; windowEnded?: boolean } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
let n = 0;
function start(seed: number, rush: boolean): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`beds1134-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(rush);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
const held = (s: GameSessionAdapter) => Object.keys(liveOf(s).beds?.owner ?? {}).length;
function toClose(s: GameSessionAdapter): void {
  expect(held(s), "no bed on the first message").toBe(0);
  for (let i = 0; i < 80 && liveOf(s).premiereEntrance!.stage !== "done"; i++) {
    step(s);
    if (liveOf(s).premiereEntrance!.stage !== "done") expect(held(s), "no bed during the entrances or the toast").toBe(0);
  }
  expect(liveOf(s).premiereEntrance!.stage).toBe("done");
}

describe("ORW-1134: beds open after the circle", () => {
  for (const rush of [true, false]) {
    it(`rush ${rush ? "on" : "off"}: no houseguest holds a bed until the circle closes`, () => {
      for (const seed of [7, 11]) toClose(start(seed, rush));
    });
  }
  it("after the close the player walks to a room with a free bed and claims it; everyone has a bed by the rush's end", () => {
    const s = start(7, true);
    toClose(s);
    expect(held(s), "the close itself claims nothing").toBe(0);
    step(s); // the first heat of the rush
    const living = new Set(s.getGameState().house.map((h) => h.id));
    const room = [...new Set(freeBeds(liveOf(s).beds as never, living).map((b) => roomOfBed(b)))][0]!;
    s.resolvePlayerMove({ text: `I run to ${room.replace("-", " ")} and take a bed there` });
    expect(liveOf(s).beds!.owner["player"], "the player holds a bed in the room they ran to").toBeDefined();
    for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks + 2 && !liveOf(s).bedRush?.done; i++) step(s);
    expect(liveOf(s).bedRush?.done, "the rush is over").toBe(true);
    for (const h of s.getGameState().house) expect(liveOf(s).beds!.owner[h.id], `${h.id} has a bed`).toBeDefined();
  });
});
