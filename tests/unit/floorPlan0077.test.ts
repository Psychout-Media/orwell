import { describe, it, expect } from "vitest";
import { HOUSE_ROOMS, HOUSE_ADJACENCY, WALKABLE_ROOMS, areAdjacent, type Room } from "../../src/domain/house";

/**
 * Feature 0077 — the recent-BB floor plan (movement layer; Phase 1). The HARD invariants from the spec:
 * the graph is symmetric, irreflexive and connected; the BATHROOM is NOT adjacent to any bedroom (owner
 * note #1 — never off a bedroom); the diary room adjoins only the living room; and the BEDROOM WING (the three
 * bedrooms) is reachable ONLY through the hallway chokepoint — so privacy is impossible in the open public
 * core and available behind the hallway. ORW-711 (owner ruling 2026-11-19, the U-shaped house): the bathroom and the
 * lounge moved off the living room (and off each other), so they are no longer behind the hallway; the new
 * floor plan itself is pinned in `houseFloorPlanOrw711.test.ts`. Roles only; pure data, no rng.
 */

const BEDROOMS: readonly Room[] = ["bedroom-a", "bedroom-b", "bedroom-c"];
const PRIVATE_WING: readonly Room[] = ["bedroom-a", "bedroom-b", "bedroom-c"];
const PUBLIC_CORE: readonly Room[] = ["kitchen", "living-room", "dining-room", "backyard"];

describe("0077 floor plan — the graph is well-formed (symmetric, irreflexive, connected)", () => {
  it("every room is in the adjacency map; no self-loops; adjacency is symmetric", () => {
    for (const r of HOUSE_ROOMS) expect(HOUSE_ADJACENCY.has(r), `${r} missing from adjacency`).toBe(true);
    for (const [room, neighbors] of HOUSE_ADJACENCY) {
      expect(neighbors).not.toContain(room); // irreflexive
      for (const n of neighbors) {
        expect(HOUSE_ADJACENCY.get(n) ?? [], `${room}→${n} not mirrored`).toContain(room); // symmetric
      }
    }
  });

  it("the house is connected — every room is reachable from the kitchen", () => {
    const seen = new Set<Room>(["kitchen"]);
    const queue: Room[] = ["kitchen"];
    while (queue.length) {
      for (const n of HOUSE_ADJACENCY.get(queue.shift()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect(seen.size).toBe(HOUSE_ROOMS.length);
  });

  it("the cast spread: 13 walkable rooms (diary is a booth, never a hangout; ORW-711 added the landing)", () => {
    expect(WALKABLE_ROOMS).not.toContain("diary-room");
    expect(WALKABLE_ROOMS.length).toBe(13);
  });
});

describe("0077 floor plan — privacy structure (the headline)", () => {
  it("the bathroom is NOT adjacent to any bedroom (owner note #1)", () => {
    for (const bed of BEDROOMS) expect(areAdjacent("bathroom", bed), `bathroom adjoins ${bed}`).toBe(false);
    expect(HOUSE_ADJACENCY.get("bathroom")).toEqual(["living-room", "lounge"]); // ORW-711: it is off the living room (and the lounge), not off the hallway
  });

  it("the diary room adjoins ONLY the living room (sealed booth)", () => {
    expect(HOUSE_ADJACENCY.get("diary-room")).toEqual(["living-room"]);
  });

  it("the bedroom wing is reachable ONLY through the hallway — never from the public core directly", () => {
    for (const priv of PRIVATE_WING) {
      for (const pub of PUBLIC_CORE) {
        expect(areAdjacent(priv, pub), `${priv} should not open onto the public ${pub}`).toBe(false);
      }
      // each private room touches the hallway (the chokepoint), so the only way in is observed movement
      expect(areAdjacent(priv, "hallway"), `${priv} must connect to the hallway`).toBe(true);
    }
    // and the public core is open among itself (privacy impossible there)
    expect(areAdjacent("kitchen", "living-room")).toBe(true);
    expect(areAdjacent("living-room", "dining-room")).toBe(true);
  });
});
