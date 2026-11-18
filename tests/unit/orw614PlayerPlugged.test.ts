import { describe, it, expect } from "vitest";
import { whisperConspicuousPairings } from "../../src/engine/houseSuspicion";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Occupancy } from "../../src/domain/house";

/** ORW-614 (P-9): the house's eye treats the player as a houseguest: the player shut in a private room with one houseguest is a pair; two houseguests plus the player are not. Roles only. */
const NPCS = [npc(1), npc(2), npc(3), npc(4)];
const lingering = () => 3;
const warm = (a: EntityId, b: EntityId) => (a === b ? 0 : 0.5);
const run = (occ: Occupancy, countPlayer: boolean) => {
  let fired = 0; const pairs: EntityId[][] = []; let heardByPlayer = 0;
  for (let seed = 0; seed < 200; seed++) {
    const knowledge = new InMemoryKnowledgeService(new InMemoryEventStore());
    const out = whisperConspicuousPairings({
      occupancy: occ, tenureOf: lingering, npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id) => `HG-${id}`,
      knowledge, rng: new SeededRandom(seed), ...(countPlayer ? { countPlayer: true } : {}),
    });
    if (out.length) { fired++; pairs.push([...out[0]!.pair]); }
    heardByPlayer += knowledge.knownTo(PLAYER).length;
  }
  return { fired, pairs, heardByPlayer };
};

describe("ORW-614 P-9: the house notices who the player spends time with", () => {
  const withPlayer = (): Occupancy => new Map<EntityId, Room>([[PLAYER, "lounge"], [npc(1), "lounge"], [npc(3), "kitchen"], [npc(4), "kitchen"], [npc(2), "kitchen"]]);
  it("the player alone with one houseguest in a private room is a whispered pair (played game)", () => {
    const r = run(withPlayer(), true);
    expect(r.fired).toBeGreaterThan(0);
    for (const p of r.pairs) expect(p).toContain(PLAYER);
    expect(r.heardByPlayer, "the player never hears their own pairing back").toBe(0);
  });
  it("parity: the same room with a houseguest in the player's place whispers the same way", () => {
    const occ = new Map<EntityId, Room>([[PLAYER, "kitchen"], [npc(1), "lounge"], [npc(2), "lounge"], [npc(3), "kitchen"], [npc(4), "kitchen"]]);
    expect(run(occ, true).fired).toBe(run(withPlayer(), true).fired);
  });
  it("not counted (headless / flag absent): byte-identical to before, nothing rises", () => {
    expect(run(withPlayer(), false).fired).toBe(0);
  });
  it("two houseguests plus the player is a crowd of three, not 'two alone'", () => {
    const occ = new Map<EntityId, Room>([[PLAYER, "lounge"], [npc(1), "lounge"], [npc(2), "lounge"], [npc(3), "kitchen"], [npc(4), "kitchen"]]);
    expect(run(occ, true).fired).toBe(0);
    expect(run(occ, false).fired).toBeGreaterThan(0);
  });
  it("a napping player is not in the room the house watches", () => {
    let fired = 0;
    for (let seed = 0; seed < 100; seed++) {
      const k = new InMemoryKnowledgeService(new InMemoryEventStore());
      fired += whisperConspicuousPairings({ occupancy: withPlayer(), tenureOf: lingering, npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (i) => `HG-${i}`, knowledge: k, rng: new SeededRandom(seed), countPlayer: true, playerAsleep: true }).length;
    }
    expect(fired).toBe(0);
  });
  it("wall: the whisper carries only the position fact", () => {
    const k = new InMemoryKnowledgeService(new InMemoryEventStore());
    for (let seed = 0; seed < 50; seed++) whisperConspicuousPairings({ occupancy: withPlayer(), tenureOf: lingering, npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (i) => `HG-${i}`, knowledge: k, rng: new SeededRandom(seed), countPlayer: true });
    for (const id of NPCS) for (const f of k.knownTo(id)) expect(f.content).toMatch(/^word in the house: .* keep slipping off to /);
  });
});
