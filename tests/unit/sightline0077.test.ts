import { describe, it, expect } from "vitest";
import {
  HOUSE_ROOMS, HOUSE_SIGHTLINE, HOUSE_ADJACENCY, areVisible, areAdjacent, isPrivateRoom,
  ROOM_ZONES, isZonedRoom, zonesFor, zonesInEarshot, zonesSameEarshot, zonesAdjacentEarshot,
  pickZone, type Room,
} from "../../src/domain/house";

/**
 * Feature 0077 Phase 2 — the SIGHTLINE graph (eyeshot). Adjacency is who you can WALK to; sightline is
 * whose occupants you can SEE. The HARD invariants: the graph is symmetric + irreflexive; the OPEN
 * PUBLIC CORE (kitchen/living-room/dining-room/backyard) is a mutual-visibility CLIQUE; the living room
 * sees into the hallway mouth and up the stairs to the landing (ORW-711); and EVERY closed door (the three bedrooms, bathroom, lounge, HOH, storage,
 * diary) is opaque from outside — crucially, the hallway sees NONE of the bedrooms it adjoins. Roles
 * only; pure data, no rng.
 */

const PUBLIC_CORE: readonly Room[] = ["kitchen", "living-room", "dining-room", "backyard"];
const CLOSED: readonly Room[] = [
  "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room",
];

describe("0077 sightline — the graph is well-formed (symmetric, irreflexive)", () => {
  it("every room is in the sightline map; no self-sightline; sightline is symmetric", () => {
    for (const r of HOUSE_ROOMS) expect(HOUSE_SIGHTLINE.has(r), `${r} missing from sightline`).toBe(true);
    for (const [room, seen] of HOUSE_SIGHTLINE) {
      expect(seen).not.toContain(room); // irreflexive
      for (const s of seen) {
        expect(HOUSE_SIGHTLINE.get(s) ?? [], `${room}→${s} sightline not mirrored`).toContain(room);
      }
    }
  });
});

describe("0077 sightline — eyeshot is the privacy structure", () => {
  it("the public core is a mutual-visibility CLIQUE (open plan + glass to the yard)", () => {
    for (const a of PUBLIC_CORE) {
      for (const b of PUBLIC_CORE) {
        if (a === b) continue;
        expect(areVisible(a, b), `${a} should see across the open core to ${b}`).toBe(true);
      }
    }
    // sightline reaches PAST a direct door here: dining ⇄ backyard are visible without being adjacent.
    // ORW-711: the living room is no longer adjacent to the yard (the yard is off to the side, off the kitchen and the dining room), yet it still sees it through the glass.
    expect(areVisible("living-room", "backyard")).toBe(true);
    expect(areAdjacent("living-room", "backyard")).toBe(false);
  });

  it("the living room sees into the hallway mouth (movement is observable there)", () => {
    expect(areVisible("living-room", "hallway")).toBe(true);
    expect(areVisible("hallway", "living-room")).toBe(true);
  });

  it("EVERY closed room is opaque from outside — and the hallway sees none of its bedrooms", () => {
    for (const room of CLOSED) {
      expect(isPrivateRoom(room), `${room} should be private (opaque from outside)`).toBe(true);
      for (const other of HOUSE_ROOMS) {
        expect(areVisible(other, room), `${other} must not see into the closed ${room}`).toBe(false);
      }
    }
    // The hallway ADJOINS the bedrooms (you can walk in) but sightline does NOT penetrate the doors.
    for (const bed of ["bedroom-a", "bedroom-b", "bedroom-c"] as const) {
      expect(areAdjacent("hallway", bed)).toBe(true);
      expect(areVisible("hallway", bed)).toBe(false);
    }
  });

  it("the public core, the hallway and the landing are the ONLY non-private rooms (privacy scarcity; ORW-711 added the semi-public landing)", () => {
    const publicRooms = HOUSE_ROOMS.filter((r) => !isPrivateRoom(r));
    expect([...publicRooms].sort()).toEqual(
      [...PUBLIC_CORE, "hallway", "landing"].sort(),
    );
  });

  it("sightline never invents a link across a wall it does not belong to (no sightline without a real opening)", () => {
    // Each sightline edge is either inside the open core, or the living-room⇄hallway mouth — never
    // a closed-door penetration. (A loose structural check: every sightline pair is adjacent OR both
    // are in the open public core.)
    for (const [a, seen] of HOUSE_SIGHTLINE) {
      for (const b of seen) {
        const bothCore = PUBLIC_CORE.includes(a) && PUBLIC_CORE.includes(b);
        expect(bothCore || areAdjacent(a, b), `${a}→${b} sightline has no opening`).toBe(true);
      }
    }
  });
});

describe("0077 zones — earshot subdivides a big room (eyeshot stays room-wide)", () => {
  it("only the big rooms are zoned; every other room is a single space", () => {
    expect([...ROOM_ZONES.keys()].sort()).toEqual(["backyard"]); // ORW-711: the lounge is one small room now, no zones
    for (const r of HOUSE_ROOMS) {
      if (r === "backyard") expect(isZonedRoom(r), `${r} should be zoned`).toBe(true);
      else { expect(isZonedRoom(r), `${r} should NOT be zoned`).toBe(false); expect(zonesFor(r)).toEqual([]); }
    }
    expect(zonesFor("backyard")).toEqual(["poolside", "patio", "workout"]);
    expect(zonesFor("lounge")).toEqual([]);
  });

  it("earshot is same-or-adjacent zone; the backyard's two ends are out of earshot", () => {
    // The pool and the workout corner are the line's two ends — NOT in earshot (the BDD case).
    expect(zonesInEarshot("backyard", "poolside", "workout")).toBe(false);
    // Adjacent zones carry a residual overhear.
    expect(zonesInEarshot("backyard", "poolside", "patio")).toBe(true);
    expect(zonesInEarshot("backyard", "patio", "workout")).toBe(true);
    // Same zone is always in earshot; symmetric.
    expect(zonesInEarshot("backyard", "patio", "patio")).toBe(true);
    expect(zonesInEarshot("backyard", "workout", "poolside")).toBe(false);
    // ORW-711: the lounge has no zones, so an old save's lounge zone reads as one single space.
    expect(zonesInEarshot("lounge", "couches", "window-nook")).toBe(true);
  });

  it("an un-zoned room (or absent zone info) is one space — pre-zone behavior preserved", () => {
    // Same-room co-presence in an un-zoned room is always in earshot (no subdivision).
    expect(zonesInEarshot("kitchen", "anything", "else")).toBe(true);
    expect(zonesInEarshot("bedroom-a", undefined, undefined)).toBe(true);
    // A missing zone on either side ⇒ treated as the same single space (back-compatible).
    expect(zonesInEarshot("backyard", undefined, "workout")).toBe(true);
    expect(zonesInEarshot("backyard", "poolside", undefined)).toBe(true);
  });

  it("witness vs. overhear split (PO ruling #791): same-zone = FULL witness, adjacent-zone = OVERHEAR only, far = nothing", () => {
    // SAME zone ⇒ full earshot (the witness predicate), but NOT an adjacent-overhear.
    expect(zonesSameEarshot("backyard", "patio", "patio")).toBe(true);
    expect(zonesAdjacentEarshot("backyard", "patio", "patio")).toBe(false);
    // ADJACENT, distinct zone ⇒ overhear-eligible only, NEVER a full witness.
    expect(zonesSameEarshot("backyard", "poolside", "patio")).toBe(false);
    expect(zonesAdjacentEarshot("backyard", "poolside", "patio")).toBe(true);
    expect(zonesSameEarshot("backyard", "patio", "workout")).toBe(false);
    expect(zonesAdjacentEarshot("backyard", "patio", "workout")).toBe(true);
    // FAR zone (the line's two ends) ⇒ neither witness NOR overhear.
    expect(zonesSameEarshot("backyard", "poolside", "workout")).toBe(false);
    expect(zonesAdjacentEarshot("backyard", "poolside", "workout")).toBe(false);
    // The lounge is one small room (ORW-711): a stale zone from an old save is no subdivision, so no intra-room overhear.
    expect(zonesAdjacentEarshot("lounge", "couches", "window-nook")).toBe(false);
    // The union `zonesInEarshot` is exactly same OR adjacent (and symmetric).
    expect(zonesInEarshot("backyard", "poolside", "patio")).toBe(true);   // adjacent
    expect(zonesInEarshot("backyard", "workout", "poolside")).toBe(false); // far
  });

  it("an un-zoned room / absent zone info is ONE space — same-earshot witness, no intra-room overhear", () => {
    // Un-zoned / undefined ⇒ the same single space: a full witness (zonesSameEarshot), and there is no
    // SEPARATE adjacent-zone to overhear from (zonesAdjacentEarshot is false) — pre-ruling behavior.
    expect(zonesSameEarshot("kitchen", "anything", "else")).toBe(true);
    expect(zonesAdjacentEarshot("kitchen", "anything", "else")).toBe(false);
    expect(zonesSameEarshot("bedroom-a", undefined, undefined)).toBe(true);
    expect(zonesAdjacentEarshot("bedroom-a", undefined, undefined)).toBe(false);
    expect(zonesSameEarshot("backyard", undefined, "workout")).toBe(true);
    expect(zonesAdjacentEarshot("backyard", undefined, "workout")).toBe(false);
  });

  it("both zone predicates are symmetric (a hears b ⇔ b hears a)", () => {
    const zs = zonesFor("backyard");
    for (const a of zs) for (const b of zs) {
      expect(zonesSameEarshot("backyard", a, b)).toBe(zonesSameEarshot("backyard", b, a));
      expect(zonesAdjacentEarshot("backyard", a, b)).toBe(zonesAdjacentEarshot("backyard", b, a));
    }
  });

  it("pickZone is deterministic, in-range, and undefined for an un-zoned room", () => {
    expect(pickZone("kitchen", 7)).toBeUndefined();
    for (let k = -5; k < 12; k++) {
      const z = pickZone("backyard", k);
      expect(z !== undefined && zonesFor("backyard").includes(z), `key ${k} → in-range zone`).toBe(true);
      expect(pickZone("backyard", k)).toBe(pickZone("backyard", k)); // stable for a given key
    }
  });
});
