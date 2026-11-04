import { describe, it, expect } from "vitest";
import { assignRooms, type MovementIntent } from "../../src/engine/presence";
import { MOVEMENT_INTENT } from "../../src/engine/presenceConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Occupancy, Room } from "../../src/domain/house";

/**
 * AMEND 0078 #1 (card 14) - steering at the DEPLOYED strength. The 0078 BDD proves the mechanism at test weight 6; the calibrated magnitude (`MOVEMENT_INTENT.moveIntentStrength`) was
 * covered only by the heavy sims. This measures it directly over ~20 ticks, seeded: a houseguest with a motive toward a target is co-located with it measurably more often than a
 * motiveless one. The measured MULTIPLE is the baseline A10 (raise the strength + per-NPC want) has to beat. Roles only.
 */
const SUBJECT = npc(1), TARGET = npc(2);
const TARGET_ROOM: Room = "lounge", START: Room = "hallway";

function share(intent: ((id: EntityId) => MovementIntent | null) | null, trials = 200, steps = 20): number {
  let inRoom = 0;
  for (let s = 0; s < trials; s++) {
    let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, START], [TARGET, TARGET_ROOM]]);
    const rng = new SeededRandom(9000 + s);
    for (let t = 0; t < steps; t++) {
      occ = assignRooms([SUBJECT], occ, { rng, affinity: () => 0, ...(intent ? { intent } : {}) }, new Map<EntityId, Room>([[TARGET, TARGET_ROOM]]));
      if (occ.get(SUBJECT) === TARGET_ROOM) inRoom++;
    }
  }
  return inRoom / (trials * steps);
}
const toward = (weight: number) => (id: EntityId): MovementIntent | null => (id === SUBJECT ? [{ target: TARGET, weight, avoid: false }] : null);

describe("movement steering at the deployed strength", () => {
  it("the deployed strength is the documented 0.15 (a change here is an A10 decision, re-measured)", () => {
    expect(MOVEMENT_INTENT.moveIntentStrength).toBe(0.15);
  });
  it("a motive-holder (typical drive weight 1) is with its target measurably more often than a motiveless houseguest", () => {
    const motiveless = share(null);
    const motivated = share(toward(1));
    const multiple = motivated / Math.max(motiveless, 1e-9);
    // eslint-disable-next-line no-console
    console.log(`[0078 deployed strength] motiveless ${motiveless.toFixed(3)} motivated ${motivated.toFixed(3)} multiple x${multiple.toFixed(2)}`);
    expect(motivated).toBeGreaterThan(motiveless);
    expect(multiple).toBeGreaterThan(1.1);
  });
  it("monotone in want: a stronger drive puts them with the target more", () => {
    expect(share(toward(2))).toBeGreaterThan(share(toward(0.5)));
  });
});
