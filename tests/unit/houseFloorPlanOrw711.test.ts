import { describe, it, expect } from "vitest";
import {
  HOUSE_ROOMS, HOUSE_ADJACENCY, HOUSE_SIGHTLINE, WALKABLE_ROOMS, areAdjacent, areVisible, canWitnessDeparture, isPrivateRoom,
  isZonedRoom, resolveRoom, occupancyViolations, type Room,
} from "../../src/domain/house";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { assignRooms } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { adrFixture } from "../support/adr0003";
import { PRIVACY } from "../../src/engine/presenceConstants";

/**
 * ORW-711 - the floor plan the owner ruled on 2026-11-19: a general U shape; the front door is in the living room; the bathroom and the one small lounge
 * are off the living room (no have-not room); the three bedrooms stay on the ground floor off the hallway; the HOH room is the only upstairs room and is reached
 * through a small semi-public landing (where people wait to see the HOH and play games); the backyard is off to the side, off the kitchen and the dining room.
 * Roles only; pure data plus the real session path for the save and the doorway watch.
 */

const neighbours = (r: Room): readonly Room[] => HOUSE_ADJACENCY.get(r) ?? [];
const same = (a: readonly Room[], b: readonly Room[]): void => expect([...a].sort()).toEqual([...b].sort());

describe("ORW-711 the floor plan", () => {
  it("every edge runs both ways, no room opens onto itself, and every room is reachable from the front door", () => {
    for (const [a, list] of HOUSE_ADJACENCY) for (const b of list) {
      expect(a).not.toBe(b);
      expect(neighbours(b), `${a} -> ${b} is not mirrored`).toContain(a);
    }
    const seen = new Set<Room>(["living-room"]);
    const queue: Room[] = ["living-room"];
    while (queue.length) for (const n of neighbours(queue.shift()!)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    expect(seen.size).toBe(HOUSE_ROOMS.length);
  });

  it("the ruled doors: the front-door living room, the side yard, the off-shoot bathroom and lounge, the ground-floor bedrooms", () => {
    same(neighbours("living-room"), ["kitchen", "dining-room", "hallway", "bathroom", "lounge", "landing", "diary-room"]);
    same(neighbours("kitchen"), ["living-room", "dining-room", "backyard", "storage-room"]);
    same(neighbours("dining-room"), ["kitchen", "living-room", "backyard"]);
    same(neighbours("backyard"), ["kitchen", "dining-room"]); // off to the side: off the kitchen and the dining room only
    expect(areAdjacent("backyard", "living-room")).toBe(false);
    same(neighbours("bathroom"), ["living-room", "lounge"]);
    same(neighbours("lounge"), ["living-room", "bathroom"]);
    same(neighbours("hallway"), ["living-room", "bedroom-a", "bedroom-b", "bedroom-c"]);
    for (const b of ["bedroom-a", "bedroom-b", "bedroom-c"] as const) same(neighbours(b), ["hallway"]);
    same(neighbours("storage-room"), ["kitchen"]);
    same(neighbours("diary-room"), ["living-room"]);
  });

  it("the HOH room is the only upstairs room and opens onto the landing alone; the landing opens onto the stairs and that door", () => {
    same(neighbours("hoh-room"), ["landing"]);
    same(neighbours("landing"), ["living-room", "hoh-room"]);
    expect(areAdjacent("hoh-room", "living-room")).toBe(false);
  });

  it("the lounge is one small room: no zones", () => {
    expect(isZonedRoom("lounge")).toBe(false);
  });

  it("the landing is a walkable, semi-public room: the player can be sent there, by its plain names, and the living room sees up to it", () => {
    expect(WALKABLE_ROOMS).toContain("landing");
    for (const word of ["landing", "the landing", "upstairs", "stairs"]) expect(resolveRoom(word)).toEqual({ kind: "ok", room: "landing" });
    expect(isPrivateRoom("landing")).toBe(false);
    expect(areVisible("living-room", "landing")).toBe(true);
    expect(areVisible("landing", "living-room")).toBe(true);
    expect(isPrivateRoom("hoh-room")).toBe(true); // the HOH room itself stays closed and private
    expect(HOUSE_SIGHTLINE.get("landing")).toEqual(["living-room"]);
  });

  it("from the landing you see who goes in and out of the HOH room; from the living room you do not", () => {
    expect(canWitnessDeparture("landing", "landing")).toBe(true); // the walk into the HOH room starts on the landing
    expect(canWitnessDeparture("living-room", "landing")).toBe(true);
    expect(canWitnessDeparture("living-room", "hoh-room")).toBe(false);
    expect(canWitnessDeparture("kitchen", "landing")).toBe(false);
  });

  it("through the real path: standing on the landing, watching a houseguest step into the HOH room leaves a tracked sighting; from the living room it does not", () => {
    const s = adrFixture("u-landing-watch", 7).sb.session;
    const subject = npc(1);
    const stage = (playerRoom: Room): void => {
      const core = s.snapshot();
      core.presence = { [PLAYER]: playerRoom, [subject]: "landing" } as Record<EntityId, Room>;
      (core.live as { champagneCircle?: string }).champagneCircle = undefined;
      s.restore(core);
    };
    stage("living-room");
    s.recordHouseguestMove(subject, "hoh room");
    expect(s.whereabouts()!.tracked.some((t) => t.id === subject && t.room === "hoh-room")).toBe(true); // the living room sees up the stairs, so the landing is in view

    const t = adrFixture("u-landing-watch-2", 7).sb.session;
    const core = t.snapshot();
    core.presence = { [PLAYER]: "kitchen", [subject]: "landing" } as Record<EntityId, Room>;
    (core.live as { champagneCircle?: string }).champagneCircle = undefined;
    t.restore(core);
    t.recordHouseguestMove(subject, "hoh room");
    expect(t.whereabouts()!.tracked.some((x) => x.id === subject), "the kitchen cannot see the landing").toBe(false);
    expect(PRIVACY.trackedConfidence).toBeGreaterThan(0);
  });

  it("walking: nobody ever steps from the living room into the HOH room in one move; the way up is the landing", () => {
    const active = [PLAYER, ...Array.from({ length: 15 }, (_, i) => npc(i + 1))];
    let reachedLanding = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rng = new SeededRandom(seed);
      let occ = assignRooms(active, null, { rng, affinity: () => 0.5 });
      for (let tick = 0; tick < 200; tick++) {
        const next = assignRooms(active, occ, { rng, affinity: () => 0.5 });
        expect(occupancyViolations(active, next, occ)).toEqual([]);
        for (const [id, room] of next) {
          const was = occ.get(id);
          if (room === "hoh-room" && was !== "hoh-room") expect(was, "the HOH room is entered from the landing").toBe("landing");
          if (room === "landing" && was !== undefined && was !== "landing") reachedLanding = true;
        }
        occ = next;
      }
    }
    expect(reachedLanding, "the landing is a room people walk through").toBe(true);
  });
});

describe("ORW-711 the house themes name the landing", () => {
  it("every theme gives the landing a name and a one-line look, and its name is its own in the house", () => {
    expect(HOUSE_THEMES.length).toBeGreaterThanOrEqual(24);
    for (const t of HOUSE_THEMES) {
      const l = t.rooms.landing;
      expect(l.name.length, `${t.id} landing name`).toBeGreaterThanOrEqual(3);
      expect(l.look.length, `${t.id} landing look`).toBeGreaterThanOrEqual(20);
      expect(l.look.length, `${t.id} landing look`).toBeLessThanOrEqual(280);
      const names = HOUSE_ROOMS.map((r) => t.rooms[r].name.toLowerCase());
      expect(new Set(names).size, `${t.id} room names are unique`).toBe(HOUSE_ROOMS.length);
    }
  });
});

describe("ORW-711 an older save still loads", () => {
  it("a save holding the player (and a houseguest, with a stale zone) in any room loads, reads back, and keeps legal moves afterwards", () => {
    for (const room of HOUSE_ROOMS) {
      const s = adrFixture(`u-old-${room}`, 5).sb.session;
      const core = JSON.parse(JSON.stringify(s.snapshot())) as ReturnType<typeof s.snapshot>;
      const other = npc(1);
      core.presence = { ...(core.presence ?? {}), [PLAYER]: room, [other]: room } as Record<EntityId, Room>;
      core.presenceBase = { ...(core.presenceBase ?? {}), [PLAYER]: room, [other]: room } as Record<EntityId, Room>;
      core.presenceZone = { [other]: "couches" } as never; // a zone the lounge used to have
      (core.live as { champagneCircle?: string }).champagneCircle = undefined;
      const fresh = adrFixture(`u-old-${room}-b`, 5).sb.session;
      expect(() => fresh.restore(JSON.parse(JSON.stringify(core)) as never), room).not.toThrow();
      const w = fresh.whereabouts();
      expect(w?.room, `the player stays in ${room}`).toBe(room);
      expect(() => { for (let i = 0; i < 4; i++) fresh.presenceTick(new SeededRandom(100 + i)); }, `ticks from ${room}`).not.toThrow();
      const occ = fresh.occupancy()!;
      for (const [, r] of occ) expect(HOUSE_ROOMS).toContain(r);
    }
  });
});
