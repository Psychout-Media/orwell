import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomOfBed, type BedsState } from "../../src/engine/beds";
import { freeBedIn } from "../../src/engine/bedClaims";
import { roomDisplayName, type Room } from "../../src/domain/house";

/**
 * ORW-522 (live sweep): claiming a bed is going to it. The player claimed a bed in their own words, the story put them in the bedroom, but the engine
 * kept them in the living room (no room was named as a move, and the front end's fallback move was pinned by the gathered house without a word).
 * Now a fresh claim is a move to that bedroom through the normal move seam: the engine moves the player, or - gathered for an event - tells the
 * narrator the player stays with the house. Roles only.
 */
type Live = { playedGame?: boolean; beds?: BedsState; premiereEntrance?: { arrived: number; playerPos: number } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };

function inside(): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw522-${Math.random()}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(false); // ORW-672 / 0201: this isolation test pins the old claim-as-they-walk-in premiere (flag off); the rush has its own tests (bedRush.test.ts)
  s.createCharacter({ playerName: "P", seed: 11 });
  liveOf(s).playedGame = true;
  // ORW-1134: beds open after the circle - run the entrances and the toast to the close (rush off: the claims then run at once)
  for (let i = 0; i < 80 && (liveOf(s).premiereEntrance as { stage?: string }).stage !== "done"; i++) step(s);
  (s as unknown as { ensureBeds(): unknown }).ensureBeds();
  return s;
}
/** A bedroom the player is not standing in that still has a free spot (the engine's own rule). */
const freeBedroom = (s: GameSessionAdapter, not: string | null | undefined): Room => {
  const room = (["bedroom-a", "bedroom-b", "bedroom-c"] as Room[]).find((r) => r !== not && freeBedIn(liveOf(s).beds ?? { owner: {}, claims: [] }, r, new Set(s.livingIds())) !== undefined);
  expect(room, "a bedroom with a free spot").toBeDefined();
  return room!;
};

describe("ORW-522: a bed claim moves the player to the bedroom, or the narrator is told why not", () => {
  it("with the house not gathered, the engine walks the player to the bedroom they claimed a bed in, before the narrator writes", () => {
    const s = inside();
    for (let i = 0; i < 60 && s.whereabouts()?.houseEvent; i++) step(s);
    expect(s.whereabouts()?.houseEvent, "the house is no longer gathered").toBeFalsy();
    const before = s.whereabouts()!.room;
    const room = freeBedroom(s, before);
    const r = s.resolvePlayerMove({ text: `I'll take the bed by the window in ${roomDisplayName(room)}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(room);
    expect(r.playerMove).toMatchObject({ from: before, to: room });
    expect(s.whereabouts()!.room).toBe(room);
  });

  it("gathered for an event, the player stays with the house and the narrator is handed the refusal, never a silent no-op", () => {
    const s = inside();
    const gathered = s.whereabouts()?.houseEvent;
    const before = s.whereabouts()!.room;
    const room = freeBedroom(s, before);
    const r = s.resolvePlayerMove({ text: `I'll take the bed by the window in ${roomDisplayName(room)}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(room);
    if (gathered) {
      expect(r.playerMove).toMatchObject({ refused: true, to: room });
      expect(s.whereabouts()!.room).toBe(before);
    } else {
      expect(r.playerMove).toMatchObject({ from: before, to: room });
      expect(s.whereabouts()!.room).toBe(room);
    }
  });

  // ORW-728 (W1-11): "My bed" twice put the player in the wrong bedroom. Only a FRESH claim moved them; a later "I go to my bed" named no room, so the narrator picked one.
  it("\"my bed\" is the bedroom of the bed the player owns, wherever they are", () => {
    const s = inside();
    for (let i = 0; i < 60 && s.whereabouts()?.houseEvent; i++) step(s);
    expect(s.whereabouts()?.houseEvent, "the house is no longer gathered").toBeFalsy();
    const room = freeBedroom(s, s.whereabouts()!.room);
    s.resolvePlayerMove({ text: `I'll take the bed by the window in ${roomDisplayName(room)}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(room);
    s.resolvePlayerMove({ text: "I head to the kitchen." });
    expect(s.whereabouts()!.room, "positive control: the player left the bedroom").not.toBe(room);
    const r = s.resolvePlayerMove({ text: "I go back to my bed." });
    expect(r.playerMove).toMatchObject({ to: room });
    expect(s.whereabouts()!.room).toBe(room);
    // a message that is not about their own bed moves nobody
    s.resolvePlayerMove({ text: "I head to the kitchen." });
    const stay = s.resolvePlayerMove({ text: "I ask whose bed that is." });
    expect(stay.playerMove).toBeNull();
  });
});
