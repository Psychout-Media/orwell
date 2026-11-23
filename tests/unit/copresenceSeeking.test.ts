import { describe, it, expect } from "vitest";
import { buildSandbox } from "../support/sandbox";
import { seekTargets, SEEK } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { assignRooms, type MovementIntent } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Occupancy, Room } from "../../src/domain/house";

/**
 * B35 (seeking, design B10 S4; flag ORWELL_GOSSIP_COPRESENCE, off by default) - a houseguest holding a high-motive fact they have not yet decided to tell someone leans their MOVEMENT toward that
 * listener, through the same pull channel as the A10 want, so the right audience is likelier to be in the room when the spread runs. Pure read, no rng, never lowers a pull; off => today's intent. Roles only.
 * ORW-810: these are the UNIT checks (inputs built by hand). The session-level checks run in a played season in tests/realpath/copresenceSeeking.test.ts.
 */
const H = npc(1), L = npc(2), O = npc(3);

describe("seekTargets (unit: a pure function on inputs built by hand)", () => {
  function setup(affinity = 0.95) {
    const sb = buildSandbox(7);
    sb.engine.knowledge.seedBelief(H, { content: "a fact", originalContent: "a fact", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H }, "origin");
    const told = new ToldLedger();
    return { k: sb.engine.knowledge, told, deps: { knowledge: sb.engine.knowledge, told, affinity: () => affinity, threat: () => 0 } };
  }
  it("names a listener who lacks the fact, with a motive from affinity and the fact's confidence", () => {
    const { deps } = setup();
    const r = seekTargets(H, [L, O], deps);
    expect(r.map((x) => x.listener).sort()).toEqual([L, O].sort());
    expect(r[0]!.motive).toBeCloseTo(0.5 * 0.95 + 0.1, 9);
  });
  it("skips a listener who already knows it, and one the holder has already decided about", () => {
    const { k, told, deps } = setup();
    k.seedBelief(L, { content: "a fact", originalContent: "a fact", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H }, "told-by:x");
    told.record(H, "f1", O, "held");
    expect(seekTargets(H, [L, O], deps)).toEqual([]);
  });
  it("is deterministic and performs no writes", () => {
    const { k, told, deps } = setup();
    const before = JSON.stringify([k.knownTo(H), k.knownTo(L), told.snapshot()]);
    expect(seekTargets(H, [L, O], deps)).toEqual(seekTargets(H, [L, O], deps));
    expect(JSON.stringify([k.knownTo(H), k.knownTo(L), told.snapshot()])).toBe(before);
  });
});

describe("the movement effect (unit: rooms and pulls built by hand): the motive-holder is with the listener more often than a same-seed control", () => {
  it("over N ticks, a seeking pull puts the holder in the listener's room markedly more than no pull", () => {
    const share = (weight: number, trials = 200, steps = 20): number => {
      let inRoom = 0;
      for (let s = 0; s < trials; s++) {
        let occ: Occupancy = new Map<EntityId, Room>([[H, "hallway"], [L, "lounge"]]);
        const rng = new SeededRandom(7000 + s);
        const intent = (id: EntityId): MovementIntent | null => (id === H && weight > 0 ? [{ target: L, weight, avoid: false }] : null);
        for (let t = 0; t < steps; t++) {
          occ = assignRooms([H], occ, { rng, affinity: () => 0, intent }, new Map<EntityId, Room>([[L, "lounge"]]));
          if (occ.get(H) === "lounge") inRoom++;
        }
      }
      return inRoom / (trials * steps);
    };
    const motive = 0.5 * 0.95 + 0.1;
    const control = share(0), seeking = share(0.5 * (1 + SEEK.k * motive)); // 0.5 = a minimal existing pull, scaled by the seeking multiplier
    expect(seeking).toBeGreaterThan(control * 1.15);
  });
});
