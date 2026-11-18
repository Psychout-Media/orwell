import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { isCommonArea, tourRoomFor, HOUSE_TOUR, houseTourSuperset } from "../../src/engine/houseTour";
import { BED_RUSH } from "../../src/engine/bedRush";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-654 / feature 0206 - the self-guided tour. Roles only; no fixture names. */
type Live = { premiereEntrance?: { stage: string; order: string[]; arrived: number; playerPos: number }; houseTour?: { seen: string[] }; champagneCircle?: string; beds?: { owner: Record<string, string>; claims: Array<{ who: string; why: string }> }; bedRush?: { done: boolean; windowEnded?: boolean } };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
let n = 0;
function start(seed: number, tour = true): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`tour-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(true);
  s.setHouseTourEnabled(tour);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" }); // a person is playing
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); return v; };
const pe = (s: GameSessionAdapter) => liveOf(s).premiereEntrance!;
/** Advance until the player has walked in. */
function toWalkedIn(s: GameSessionAdapter): void { for (let i = 0; i < 20 && pe(s).arrived <= pe(s).playerPos; i++) step(s); }
/** Advance until every houseguest is in (the tour's second half). */
function toEveryoneIn(s: GameSessionAdapter): void { for (let i = 0; i < 20 && pe(s).arrived < pe(s).order.length; i++) step(s); }
const where = (s: GameSessionAdapter) => s.whereabouts()!;

describe("the tour: the player is free once they have walked in, and not before", () => {
  it("before the player's own entrance the house holds the player; after it they can walk", () => {
    const seed = [3, 5, 7, 9, 11, 13, 17].find((x) => { const t = start(x); return pe(t).playerPos >= 2; })!;
    const s = start(seed);
    expect(pe(s).arrived).toBeLessThanOrEqual(pe(s).playerPos);
    const before = where(s).room;
    s.movePlayer("kitchen");
    expect(where(s).room, "held before they walk in").toBe(before);
    toWalkedIn(s);
    expect(pe(s).stage).toBe("entrances");
    s.movePlayer("kitchen");
    expect(where(s).room).toBe("kitchen");
    s.movePlayer("living-room");
    expect(where(s).room).toBe("living-room");
  });
  it("the stage stays entrances through the tour; the next advance after the last arrival calls the circle, and the player is in the living room", () => {
    const s = start(7);
    toEveryoneIn(s);
    expect(pe(s).stage).toBe("entrances");
    expect(liveOf(s).champagneCircle).not.toBe("gathered");
    s.movePlayer("backyard");
    expect(where(s).room).toBe("backyard");
    const v = step(s);
    expect(pe(s).stage).toBe("toast");
    expect(liveOf(s).champagneCircle).toBe("gathered");
    expect(where(s).room, "production calls the house to the living room").toBe("living-room");
    expect(JSON.stringify(v.event)).toContain("called");
    s.movePlayer("kitchen");
    expect(where(s).room, "held again at the circle").toBe("living-room");
  });
});

describe("the tour: the houseguests gather in the common area, a few wander", () => {
  it("most inside are in the common area and a bounded few are elsewhere, over several seeds", () => {
    let outside = 0, total = 0;
    for (const seed of [2, 4, 6, 8, 10, 12]) {
      const s = start(seed);
      toEveryoneIn(s);
      const w = where(s);
      const everyone = s.getGameState().house.filter((h) => h.id !== "player");
      const rooms = new Map<string, string>();
      const seen = s.whereabouts({ search: true })!;
      for (const h of seen.search!.houseguests) if (h.room) rooms.set(h.id, h.room);
      void w; void everyone;
      // read the engine's own map for the count (the search view only names rooms in view)
      const pres = (s as unknown as { presence: Map<string, string> }).presence;
      for (const [id, room] of pres) { if (id === "player") continue; total++; if (!isCommonArea(room as never)) outside++; }
    }
    expect(outside / total, "a few wander").toBeLessThan(0.5);
    expect(outside, "somebody wanders over six seeds").toBeGreaterThan(0);
  });
  it("placement is a keyed side stream: the same inputs give the same room, and the wander share is bounded", () => {
    let wander = 0;
    for (let i = 0; i < 400; i++) if (!isCommonArea(tourRoomFor(1, `x${i}`, "1:1"))) wander++;
    expect(wander / 400).toBeLessThan(HOUSE_TOUR.wanderShare + 0.1);
    expect(tourRoomFor(1, "a", "2:2")).toBe(tourRoomFor(1, "a", "2:2"));
  });
});

describe("the tour: no bed is claimed on the tour (0201 holds)", () => {
  it("no claim before the circle closes, and the whole premiere still ends with sixteen distinct beds, nobody claimed twice (3 seeds)", () => {
    for (const seed of [7, 11, 21]) {
      const s = start(seed);
      for (let i = 0; i < 80 && pe(s).stage !== "done"; i++) {
        step(s);
        expect(liveOf(s).beds?.claims.length ?? 0).toBe(0);
        if (pe(s).stage === "entrances" && pe(s).arrived > pe(s).playerPos) s.movePlayer(i % 2 ? "kitchen" : "dining-room");
      }
      for (let i = 0; i < 12 && !liveOf(s).bedRush?.done && !liveOf(s).bedRush?.windowEnded; i++) step(s);
      (s as unknown as { bedThePlayer(): void }).bedThePlayer();
      const l = liveOf(s);
      expect(Object.keys(l.beds!.owner).length).toBe(16);
      expect(new Set(Object.values(l.beds!.owner)).size).toBe(16);
      const first = l.beds!.claims.filter((c) => c.why === "move-in");
      expect(new Set(first.map((c) => c.who)).size).toBe(first.length);
      expect(BED_RUSH.ticks).toBeGreaterThan(0);
    }
  });
});

describe("the tour: the one-time room card", () => {
  it("fires on the first entry into each room, once, only for the player", () => {
    const s = start(7);
    toWalkedIn(s);
    expect(liveOf(s).houseTour!.seen, "the entrance room is the first card").toContain("living-room");
    s.movePlayer("kitchen");
    expect(where(s).roomCard?.room).toBe("kitchen");
    expect(where(s).roomCard?.name.length).toBeGreaterThan(0);
    s.noteMessage({ messageId: "m2" });
    expect(where(s).roomCard, "only on the turn of the entry").toBeUndefined();
    s.movePlayer("living-room"); s.movePlayer("kitchen");
    s.noteMessage({ messageId: "m3" });
    s.movePlayer("living-room");
    s.movePlayer("kitchen");
    expect(where(s).roomCard, "never a second card for the same room").toBeUndefined();
    const seen = liveOf(s).houseTour!.seen;
    expect(new Set(seen).size).toBe(seen.length);
    // an NPC walking into a room never triggers it
    const before = [...seen];
    (s as unknown as { presence: Map<string, string> }).presence.set("npc:x", "bathroom");
    expect(liveOf(s).houseTour!.seen).toEqual(before);
  });
  it("survives save and restore (monotonic), and the save check refuses a thinner record", () => {
    const s = start(7);
    toWalkedIn(s);
    s.movePlayer("kitchen"); s.movePlayer("dining-room");
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const again = new GameSessionAdapter((s as unknown as { rel: never }).rel); again.restore(snap as never);
    expect(liveOf(again).houseTour!.seen).toEqual(liveOf(s).houseTour!.seen);
    again.noteMessage({ messageId: "m9" });
    again.movePlayer("kitchen"); // a seen room: no card
    expect(where(again).roomCard).toBeUndefined();
    expect(houseTourSuperset({ seen: ["a"] }, { seen: ["a", "b"] })).toBe(false);
    expect(houseTourSuperset({ seen: ["a", "b", "c"] }, { seen: ["a", "b"] })).toBe(true);
  });
  it("the card carries no number and nothing hidden (wall sentinel)", () => {
    const s = start(7);
    toWalkedIn(s);
    s.movePlayer("hallway");
    const card = where(s).roomCard!;
    expect(card).toBeDefined();
    const text = JSON.stringify(card);
    for (const banned of ["affinity", "trust", "threat", "secret", "vault", "grudge", "soul", "score", "weight"]) expect(text.toLowerCase(), banned).not.toContain(banned);
    expect(text.match(/\d/g), "number-free").toBeNull();
  });
});

describe("the tour: flag off is the old premiere", () => {
  it("off, the player is held through the entrances and the circle follows the last arrival at once", () => {
    const s = start(7, false);
    expect(liveOf(s).houseTour).toBeUndefined();
    for (let i = 0; i < 20 && pe(s).stage === "entrances"; i++) {
      const before = where(s).room;
      s.movePlayer("kitchen");
      expect(where(s).room).toBe(before);
      step(s);
    }
    expect(pe(s).stage).toBe("toast");
    expect(liveOf(s).champagneCircle).toBe("gathered");
  });
});
