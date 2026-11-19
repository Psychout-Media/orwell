import { describe, it, expect } from "vitest";
import { assignRooms } from "../../src/engine/presence";
import type { MovementIntent } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Occupancy } from "../../src/domain/house";

/**
 * Feature 0078 Phase 1 — INTENTIONAL movement: NPCs move toward what their motivation points at (a
 * bond to build, a rival/target to work) and away from a pure threat, so co-presence is EARNED, not
 * arbitrary drift. The headline behavior is the measurable TREND toward the target; the load-bearing
 * safety property is that intent re-weights the existing draws WITHOUT adding any of its own (the
 * per-NPC draw count is unchanged — the calibration spine re-phases only by WHICH room intent steers
 * toward, which the seeded juryReach + gradient gates re-verify). Roles only — no names.
 *
 * Each fixture pins the TARGET in a fixed room (so it is in the occupancy the mover reads) and zeroes
 * affinity, isolating intent as the only steering force. The subject starts in the living room — adjacent
 * to the lounge (a private room) — so the target's room is a legal one-step destination.
 */

const SUBJECT = npc(1);
const TARGET = npc(2);
const TARGET_ROOM: Room = "lounge";
const START: Room = "living-room"; // adjacent to the lounge (ORW-711: the lounge is off the living room now, not the hallway)

function towardTarget(weight = 1, avoid = false): (id: EntityId) => MovementIntent | null {
  return (id) => (id === SUBJECT ? [{ target: TARGET, weight, avoid }] : null);
}

/**
 * The fraction of all ticks (across seeded MULTI-step trajectories) the subject spends in the TARGET's
 * room. A multi-tick walk compounds the per-tick steering: a pursuing mover reaches the target's room
 * and the stay-weight (the target is there) holds it, so the time-together gap is crisp — exactly the
 * "earned co-presence" the feature is about. The bonus is bounded (steer, not force), so a strong test
 * weight is used to exercise the MECHANISM clearly; the calibrated magnitude (0.2) is the heavy sims' job.
 */
function timeWithTarget(intent: ((id: EntityId) => MovementIntent | null) | null, trials = 100, steps = 6): number {
  let inRoom = 0;
  for (let s = 0; s < trials; s++) {
    let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, START], [TARGET, TARGET_ROOM]]);
    const rng = new SeededRandom(5000 + s);
    for (let t = 0; t < steps; t++) {
      occ = assignRooms([SUBJECT], occ, { rng, affinity: () => 0, ...(intent ? { intent } : {}) },
        new Map<EntityId, Room>([[TARGET, TARGET_ROOM]])); // pin the target so the mover reads it
      if (occ.get(SUBJECT) === TARGET_ROOM) inRoom++;
    }
  }
  return inRoom / (trials * steps);
}

describe("0078 intentional movement — co-presence earned by intent", () => {
  it("a houseguest PURSUES its motive target — spending far more time in its room than a motiveless one", () => {
    const motiveless = timeWithTarget(null);
    const motivated = timeWithTarget(towardTarget(6));
    // With affinity zeroed, a motiveless mover drifts; a motivated one seeks the target out and lingers.
    // The spread IS the feature (co-presence earned by intent, not luck).
    expect(motivated).toBeGreaterThan(motiveless + 0.12);
  });

  it("an AVOID intent steers the houseguest AWAY from a pure threat's room", () => {
    const motiveless = timeWithTarget(null);
    const avoidant = timeWithTarget(towardTarget(6, true)); // a strong danger to keep distance from
    expect(avoidant).toBeLessThan(motiveless);
  });

  it("shuffling the agenda changes where the houseguest ends up (intent, not luck)", () => {
    // Same seed slice, two different agendas (pursue the target vs. no agenda). The co-presence outcome
    // MOVES with the agenda — the .feature's "shuffling agendas shifts co-presence".
    expect(Math.abs(timeWithTarget(towardTarget(6)) - timeWithTarget(null))).toBeGreaterThan(0.12);
  });

  it("intent draws NO extra rng beyond the move-gate it bends (no side-channel draw)", () => {
    // Intent re-weights the move-gate threshold + the destination weights but NEVER draws rng of its
    // own — exactly one gate draw, plus at most one destination draw, with or without intent (never a
    // third "intent" draw). This is the per-NPC draw-count invariant the calibration spine rests on.
    function draws(intent: ((id: EntityId) => MovementIntent | null) | null): number {
      let count = 0;
      const base = new SeededRandom(31);
      const rng = {
        next: () => { count++; return base.next(); },
        int: (n: number) => base.int(n),
        pick: <T,>(xs: readonly T[]) => base.pick(xs),
        fork: (l: string) => base.fork(l),
      };
      const prev: Occupancy = new Map<EntityId, Room>([[SUBJECT, START], [TARGET, TARGET_ROOM]]);
      assignRooms([SUBJECT], prev, { rng, affinity: () => 0, ...(intent ? { intent } : {}) },
        new Map<EntityId, Room>([[TARGET, TARGET_ROOM]]));
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(2); // gate + optional destination — never a third intent draw
      return count;
    }
    draws(null);
    draws(towardTarget(1));
  });

  it("absent intent ⇒ BYTE-IDENTICAL to the pre-0078 base (intent is opt-in)", () => {
    // The same seeded stream with no `intent` dep vs. an intent dep that returns null must produce the
    // identical trajectory — intent is a pure additive nudge, inert when there is no agenda.
    const run = (withNullIntent: boolean): string => {
      let occ: Occupancy = new Map<EntityId, Room>([[npc(1), "kitchen"], [npc(2), "backyard"], [npc(3), "hallway"]]);
      const rng = new SeededRandom(99);
      const trail: string[] = [];
      for (let t = 0; t < 20; t++) {
        occ = assignRooms([npc(1), npc(2), npc(3)], occ, {
          rng, affinity: (a, b) => (a === b ? 0 : 0.3),
          ...(withNullIntent ? { intent: () => null } : {}),
        });
        trail.push([...occ.entries()].map(([id, r]) => `${id}@${r}`).sort().join(","));
      }
      return trail.join("|");
    };
    expect(run(true)).toBe(run(false));
  });

  it("same seed ⇒ identical intent-weighted trajectories (movement stays reproducible)", () => {
    const run = (): string => {
      let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, START], [TARGET, TARGET_ROOM]]);
      const rng = new SeededRandom(7);
      const trail: string[] = [];
      for (let t = 0; t < 20; t++) {
        occ = assignRooms([SUBJECT, TARGET], occ, { rng, affinity: () => 0, intent: towardTarget(1) });
        trail.push([...occ.entries()].map(([id, r]) => `${id}@${r}`).sort().join(","));
      }
      return trail.join("|");
    };
    expect(run()).toBe(run());
  });
});
