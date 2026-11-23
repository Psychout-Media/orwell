import { describe, it, expect } from "vitest";

import { wantScale, DESIRE, WANT_MOVEMENT } from "../../src/engine/desireClock";
import { assignRooms, type MovementIntent } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Occupancy, Room } from "../../src/domain/house";

/** A10: NPC movement from one internal WANT (flag ORWELL_WANT_MOVEMENT). UNIT checks: the pure scale and the movement share (ORW-812: the session checks are played in tests/realpath/wantMovement.test.ts). Roles only. */
describe("wantScale (pure)", () => {
  it("is 1 with no urgency, rises monotonically, and tops out at 1 + k at/over the approach threshold", () => {
    expect(wantScale(0)).toBe(1);
    expect(wantScale(-5)).toBe(1);
    expect(wantScale(DESIRE.threshold / 2)).toBeCloseTo(1 + WANT_MOVEMENT.k / 2, 9);
    expect(wantScale(DESIRE.threshold)).toBeCloseTo(1 + WANT_MOVEMENT.k, 9);
    expect(wantScale(DESIRE.threshold * 10)).toBeCloseTo(1 + WANT_MOVEMENT.k, 9);
    expect(wantScale(1)).toBeGreaterThan(wantScale(0.2));
  });
});

// ORW-812: the session-level want checks run in a played season (every layer as shipped): tests/realpath/wantMovement.test.ts.

describe("the movement effect (co-presence), at the deployed strength", () => {
  const SUBJECT = npc(1), TARGET = npc(2);
  const share = (weight: number, trials = 200, steps = 20): number => {
    let inRoom = 0;
    for (let s = 0; s < trials; s++) {
      let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, "hallway"], [TARGET, "bedroom-a"]] /* ORW-711: the old pin was hallway -> lounge; the lounge left the hallway, so the same hub-to-leaf-room geometry is hallway -> a bedroom */);
      const rng = new SeededRandom(9000 + s);
      const intent = (id: EntityId): MovementIntent | null => (id === SUBJECT ? [{ target: TARGET, weight, avoid: false }] : null);
      for (let t = 0; t < steps; t++) {
        occ = assignRooms([SUBJECT], occ, { rng, affinity: () => 0, intent }, new Map<EntityId, Room>([[TARGET, "bedroom-a"]]));
        if (occ.get(SUBJECT) === "bedroom-a") inRoom++;
      }
    }
    return inRoom / (trials * steps);
  };
  it("a want at full urgency (x(1+k)) puts the NPC with its target markedly more than the same NPC with no urgency", () => {
    const calm = share(1), urgent = share(wantScale(DESIRE.threshold));
    // eslint-disable-next-line no-console
    console.log(`[A10] calm ${calm.toFixed(3)} urgent ${urgent.toFixed(3)} multiple x${(urgent / calm).toFixed(2)}`);
    expect(urgent / calm).toBeGreaterThan(1.3);
  });
});
