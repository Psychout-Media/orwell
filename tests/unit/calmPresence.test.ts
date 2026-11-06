import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { Occupancy } from "../../src/domain/house";

/**
 * ORW-212 / ORW-210 (Ryne's playtest: "they are all moving too fast" and "NPCs gravitate to wherever the player is"): the player-facing movement is calm and non-magnetic. Roles only.
 * Measured here with the player pinned in one room over many presence ticks; ORWELL_CALM_PRESENCE off reproduces the pre-fix numbers (the BEFORE column), on is the AFTER.
 */
type P = { presence: Map<string, string>; presenceBase: Map<string, string> | null; presenceTick(rng: SeededRandom): void; setCalmPresenceEnabled(on: boolean): void; noteConversationPartners(ids: string[]): void };
const T = 150, SEEDS = 6;
function run(calm: boolean, partners: (npcs: string[]) => string[]) {
  let maxOrigins = 0, inRoom = 0, slots = 0, maxSimul = 0, moves = 0, npcTicks = 0, partnerStay = 0, partnerTicks = 0; const rooms = new Set<string>();
  const baseTrace: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`calm-${calm}-${seed}-${Math.random()}`);
    sb.session.createCharacter({ playerName: "P", archetype: "floater", seed });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as P; g.setCalmPresenceEnabled(calm);
    const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
    const talking = partners(npcs);
    const rng = new SeededRandom(seed * 7919);
    g.presence.set(PLAYER, "living-room");
    let prev: Occupancy = new Map(g.presence) as Occupancy;
    for (let t = 0; t < T; t++) {
      g.presence.set(PLAYER, "living-room"); g.presenceBase?.set(PLAYER, "living-room");
      if (talking.length) g.noteConversationPartners(talking); // the player keeps talking to them
      g.presenceTick(rng);
      let simul = 0; const origins = new Set<string>();
      for (const id of npcs) {
        const now = g.presence.get(id), was = prev.get(id); if (!now) continue; rooms.add(now);
        slots++; if (now === "living-room") inRoom++;
        if (was !== undefined) { npcTicks++; if (was !== now) { moves++; simul++; origins.add(was); } }
        if (talking.includes(id) && was === "living-room") { partnerTicks++; if (now === "living-room") partnerStay++; }
      }
      maxSimul = Math.max(maxSimul, simul); maxOrigins = Math.max(maxOrigins, origins.size);
      prev = new Map(g.presence) as Occupancy;
      if (seed === 1) baseTrace.push(JSON.stringify([...(g.presenceBase ?? new Map())].sort()));
    }
  }
  return { maxOrigins, share: inRoom / slots, rooms: rooms.size, maxSimul, movesPerNpcTick: moves / Math.max(1, npcTicks), partnerStay: partnerTicks ? partnerStay / partnerTicks : NaN, baseTrace: baseTrace.join("|") };
}

describe("calm, non-magnetic presence (ORW-212 / ORW-210)", () => {
  const before = run(false, () => []), after = run(true, () => []);
  it("BEFORE/AFTER numbers (printed for the card)", () => {
    // eslint-disable-next-line no-console
    console.log(`CALM before(off): share-in-player-room ${(100 * before.share).toFixed(1)}%, moves/NPC/tick ${before.movesPerNpcTick.toFixed(3)}, max same-tick moves ${before.maxSimul} | after(on): share ${(100 * after.share).toFixed(1)}%, moves/NPC/tick ${after.movesPerNpcTick.toFixed(3)}, max same-tick moves ${after.maxSimul}, max departure rooms in one tick ${after.maxOrigins} (before ${before.maxOrigins}) | rooms ${after.rooms}`);
    expect(before.share).toBeGreaterThan(0.3);
  });
  it("no gravity: with no live conversation the time spent in the player's room is near an even share (at most ~2x), not the previous magnet", () => {
    expect(after.share).toBeLessThan(2 * (1 / after.rooms));
    expect(after.share).toBeLessThan(before.share / 2);
  });
  it("gradual: far fewer houseguests change rooms per tick, and never a large same-tick reshuffle (mover cap)", () => {
    expect(after.movesPerNpcTick).toBeLessThan(before.movesPerNpcTick * 0.75);
    expect(after.maxSimul).toBeLessThanOrEqual(Math.max(1, Math.floor(15 * 0.2)));
    expect(before.maxSimul).toBeGreaterThan(after.maxSimul);
  });
  it("staggered: moves out of DIFFERENT rooms never line up in one tick (only a group leaving the same room together); the old behaviour did", () => {
    expect(after.maxOrigins).toBeLessThanOrEqual(1);
    expect(before.maxOrigins).toBeGreaterThan(1);
  });
  it("real conversations still hold: the houseguests the player is talking to stay in the room far more than the cold-start rate", () => {
    const talking = run(true, (npcs) => npcs.slice(0, 2));
    expect(talking.partnerStay).toBeGreaterThan(0.8);
  });
  it("the calibration-neutral BASE view is untouched by the flag (same trace on and off)", () => {
    expect(after.baseTrace).toBe(before.baseTrace);
  });
});
