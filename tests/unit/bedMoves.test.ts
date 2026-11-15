import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { freeBeds, roomOfBed, type BedsState } from "../../src/engine/beds";
import { planGoalMove, bedmateShare, type BedReader } from "../../src/engine/bedClaims";
import { roomDisplayName, type Room } from "../../src/domain/house";

/** ORW-466 slice 3 - later bed moves: the player claims a free spot later in their own words, a taken spot needs its owner's yes, NPCs move for a goal (toward an ally, away from a betrayer), an
 * eviction's empty bed is noticed publicly, and a move away is a tiny slight. Roles only. Test-only seams on `live` / `rel` (as in the other bed tests). */
type Live = { playedGame?: boolean; beds?: BedsState; evictionOrder: string[]; mannerByEvictee?: Record<string, Record<string, { betrayed?: boolean }>> };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const relOf = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { affinity: number; trust: number } } }).rel;
const phaseOf = (s: GameSessionAdapter) => (s as unknown as { phase: string }).phase;

function played() {
  const sb = new GameSessionRegistry().sandboxFor(`bedmoves-${Math.random()}`);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  liveOf(s).playedGame = true;
  for (let i = 0; i < 40 && phaseOf(s) === "premiere"; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.setBedMoveChance(0);
  s.bedsTick(); // the NPCs own their beds
  return { s, events: sb.engine.events };
}
const nameOf = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!.name;
const living = (s: GameSessionAdapter) => new Set(s.livingIds());
/** The player claims the one spot left after move-in. */
const playerTakesLeftover = (s: GameSessionAdapter) => {
  const room = roomOfBed(freeBeds(liveOf(s).beds!, living(s))[0]!);
  s.resolvePlayerMove({ text: `I'll take a bed in ${roomDisplayName(room)}.` });
  expect(liveOf(s).beds!.owner["player"]).toBeDefined();
};
/** Evict an NPC sleeping in a room other than `not` (a test seam: the evicted list is what "in the house" reads). */
const evictOne = (s: GameSessionAdapter, not?: Room) => {
  const beds = liveOf(s).beds!;
  const id = Object.keys(beds.owner).find((o) => o !== "player" && roomOfBed(beds.owner[o]!) !== not)!;
  liveOf(s).evictionOrder.push(id);
  return id;
};

describe("later bed moves (ORW-466 slice 3)", () => {
  it("after move-in the player claims a free spot in their own words: the claim lands as a later move", () => {
    const { s } = played();
    playerTakesLeftover(s);
    const mine = liveOf(s).beds!.owner["player"]!;
    const gone = evictOne(s, roomOfBed(mine));
    const target = roomOfBed(liveOf(s).beds!.owner[gone]!);
    s.resolvePlayerMove({ text: `I'm going to grab the empty bed in ${roomDisplayName(target)}.` });
    const beds = liveOf(s).beds!;
    expect(roomOfBed(beds.owner["player"]!)).toBe(target);
    expect(beds.claims.at(-1)).toMatchObject({ who: "player", why: "move" });
    expect(s.getMomentPrompt({}).systemPrompt).toMatch(/the player just claimed/);
  });

  it("after move-in a taken spot needs its owner's yes", () => {
    for (const [affinity, yes] of [[0, false], [0.95, true]] as const) {
      const { s } = played();
      playerTakesLeftover(s);
      const beds = liveOf(s).beds!;
      const owner = Object.keys(beds.owner).find((o) => o !== "player" && roomOfBed(beds.owner[o]!) === roomOfBed(beds.owner["player"]!))!;
      const theirs = beds.owner[owner]!;
      relOf(s).edge(owner, "player").affinity = affinity;
      s.resolvePlayerMove({ text: `Can I swap beds with ${nameOf(s, owner)}?` });
      expect(beds.owner["player"] === theirs, `swap ${yes ? "accepted" : "refused"}`).toBe(yes);
      if (yes) expect(beds.claims.at(-1)?.why).toBe("swap");
    }
  });

  it("a spot freed by an eviction is anyone's for the taking: the player takes it without asking anyone", () => {
    const { s } = played();
    playerTakesLeftover(s);
    const beds = liveOf(s).beds!;
    const gone = evictOne(s, roomOfBed(beds.owner["player"]!));
    const spot = beds.owner[gone]!;
    for (const o of Object.keys(beds.owner)) if (o !== "player") relOf(s).edge(o, "player").affinity = 0; // nobody would say yes to a swap
    s.resolvePlayerMove({ text: `I'll take ${nameOf(s, gone)}'s old bed in ${roomDisplayName(roomOfBed(spot))}.` });
    expect(roomOfBed(beds.owner["player"]!)).toBe(roomOfBed(spot));
    expect(beds.claims.at(-1)).toMatchObject({ who: "player", why: "move" });
  });

  it("the goal planner: an NPC moves toward an ally into a free spot, and away from a betrayer; no goal, no move", () => {
    const reader: BedReader = { stats: () => ({ social: 0.5, mental: 0.5 }), warmth: () => 0 };
    const state: BedsState = { owner: { mover: "bedroom-a#s1", ally: "bedroom-b#s1", rat: "bedroom-a#s2", gone: "bedroom-b#s2" }, claims: [] };
    const inHouse = new Set(["mover", "ally", "rat"]); // "gone" was evicted: their spot is free
    const free = (spot: string) => !Object.entries(state.owner).some(([o, s]) => s === spot && inHouse.has(o));
    const plan = (goals: { toward: string[]; away: string[] }) =>
      planGoalMove(state, ["mover"], inHouse, reader, bedmateShare(reader, 0.25), (w) => (w === "mover" ? goals : { toward: [], away: [] }));
    const toward = plan({ toward: ["ally"], away: [] })!;
    expect(roomOfBed(toward.to), "into the ally's room").toBe("bedroom-b");
    expect(toward.joined).toEqual(["ally"]);
    expect(free(toward.to)).toBe(true);
    const away = plan({ toward: [], away: ["rat"] })!;
    expect(roomOfBed(away.to), "out of the betrayer's room").not.toBe("bedroom-a");
    expect(away.left).toContain("rat");
    expect(plan({ toward: [], away: [] }), "no goal and only a small gain: nobody moves").toBeUndefined();
  });

  it("an eviction frees the spot (the owner entry stays) and the house notices the empty bed once, as a public event", () => {
    const { s, events } = played();
    playerTakesLeftover(s);
    const gone = evictOne(s);
    const spot = liveOf(s).beds!.owner[gone]!;
    s.bedsTick();
    s.bedsTick();
    const beds = liveOf(s).beds!;
    expect(beds.owner[gone], "history kept").toBe(spot);
    expect(freeBeds(beds, living(s))).toContain(spot);
    const notes = events.queryAll().filter((e) => e.type === "bed-claim" && e.content.includes("sits empty"));
    expect(notes.length, "noticed once").toBe(1);
    expect(notes[0]!.hidden).toBe(false);
    expect(notes[0]!.witnessSet).toContain("player");
  });

  it("an NPC moves away from a betrayer when the day's chance hits: a public move, and the betrayer feels a tiny slight", () => {
    const { s, events } = played();
    playerTakesLeftover(s);
    const beds = liveOf(s).beds!;
    const npcs = Object.keys(beds.owner).filter((o) => o !== "player");
    const mover = npcs[0]!;
    const room = roomOfBed(beds.owner[mover]!);
    const rat = npcs.find((o) => o !== mover && roomOfBed(beds.owner[o]!) === room)!;
    const gone = evictOne(s, room);
    const there = roomOfBed(beds.owner[gone]!);
    const friend = npcs.find((o) => o !== gone && roomOfBed(beds.owner[o]!) === there)!;
    relOf(s).edge(mover, friend).affinity = 1; relOf(s).edge(friend, mover).affinity = 1; // and they have a showmance over there (the strongest mutual affinity)
    (liveOf(s).mannerByEvictee ??= {})[mover] = { [rat]: { betrayed: true } };
    relOf(s).edge(mover, rat).affinity = 0; // they can't stand them now
    const before = relOf(s).edge(rat, mover).affinity;
    s.setBedMoveChance(1);
    s.bedsTick();
    expect(roomOfBed(beds.owner[mover]!), "moved out of the betrayer's room").not.toBe(room);
    expect(beds.claims.at(-1)).toMatchObject({ who: mover, why: "move" });
    const ev = events.queryAll().filter((e) => e.type === "bed-claim").at(-1)!;
    expect(ev.content).toContain(nameOf(s, mover));
    expect(ev.hidden).toBe(false);
    const after = relOf(s).edge(rat, mover).affinity;
    expect(after).toBeLessThan(before);
    expect(before - after, "a tiny slight").toBeLessThan(0.05);
    s.bedsTick();
    expect(beds.claims.filter((c) => c.why === "move" && c.who !== "player").length, "at most one goal move per day").toBe(1);
  });
});
