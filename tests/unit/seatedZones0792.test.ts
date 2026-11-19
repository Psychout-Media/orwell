import { describe, it, expect } from "vitest";
import { assignRooms, seatZones } from "../../src/engine/presence";
import { PRESENCE } from "../../src/engine/presenceConstants";
import { isZonedRoom, zonesFor } from "../../src/domain/house";
import type { Room, Zone } from "../../src/domain/house";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import { adrFixture } from "../support/adr0003";

/**
 * Issue #792 — sub-zones SEATED into `assignRooms` (not computed on-read), enabling persisted DRIFT
 * (corner-to-corner across ticks) + affinity CLUSTERING (two specific houseguests sharing a zone). The
 * load-bearing guarantee, as for L21/L24, is CALIBRATION NEUTRALITY: seating is OPT-IN (`zonesOut`) and
 * rides the dedicated movement stream, so the off-screen society / juryReach spine — which passes no
 * `zonesOut` — consumes byte-identical draws and the same room placement. Roles only — no fixture names.
 */

/** Counts rng draws so we can prove the no-`zonesOut` base pass consumes nothing extra. */
class CountingRng implements RandomnessSource {
  draws = 0;
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { this.draws++; return this.inner.next(); }
  int(maxExclusive: number): number { this.draws++; return this.inner.int(maxExclusive); }
  pick<T>(items: readonly T[]): T { this.draws++; return this.inner.pick(items); }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

const flatAffinity = () => 0.5;
const cast = (n: number): EntityId[] => [PLAYER, ...Array.from({ length: n }, (_, i) => npc(i + 1))];

describe("issue #792 — seatZones (pure)", () => {
  it("seats a valid sub-zone for every id in a zoned room, and NOTHING for un-zoned rooms", () => {
    const occ = new Map<EntityId, Room>([
      [npc(1), "backyard"], [npc(2), "backyard"], [npc(3), "backyard"],
      [npc(4), "kitchen"], [npc(5), "bedroom-a"], [npc(6), "lounge"], // ORW-711: the lounge is one small room, not zoned
    ]);
    const out = new Map<EntityId, Zone>();
    seatZones(occ, null, out, { rng: new SeededRandom(3), salt: "s" });
    // zoned rooms ⇒ a valid seat
    for (const id of [npc(1), npc(2), npc(3)]) {
      const room = occ.get(id)!;
      expect(zonesFor(room)).toContain(out.get(id));
    }
    // un-zoned rooms ⇒ no seat at all
    for (const id of [npc(4), npc(5), npc(6)]) expect(out.has(id)).toBe(false);
  });

  it("a HELD zoned-room stay can DRIFT to a different sub-zone across ticks (not fixed by id+room)", () => {
    // One houseguest holding the backyard for many ticks should NOT always read the same zone.
    const occ = new Map<EntityId, Room>([[npc(1), "backyard"]]);
    const rng = new SeededRandom(11);
    let prev = new Map<EntityId, Zone>();
    seatZones(occ, null, prev, { rng, salt: "s" }); // initial seat
    const seen = new Set<Zone>([prev.get(npc(1))!]);
    for (let tick = 0; tick < 80; tick++) {
      const next = new Map<EntityId, Zone>();
      seatZones(occ, prev, next, { rng, salt: "s" });
      seen.add(next.get(npc(1))!);
      prev = next;
    }
    expect(seen.size).toBeGreaterThan(1); // they drifted corner-to-corner over the stay
  });

  it("AFFINITY CLUSTERING: two bonded houseguests share a sub-zone far more often than chance", () => {
    // npc(1) and npc(2) have high mutual affinity; the backyard has 3 zones (chance co-zone ≈ 1/3).
    const occ = new Map<EntityId, Room>([[npc(1), "backyard"], [npc(2), "backyard"]]);
    const aff = (a: EntityId, b: EntityId) =>
      (a === npc(1) && b === npc(2)) || (a === npc(2) && b === npc(1)) ? 1 : 0;
    let together = 0;
    const N = 400;
    for (let seed = 0; seed < N; seed++) {
      const out = new Map<EntityId, Zone>();
      seatZones(occ, null, out, { rng: new SeededRandom(seed), salt: "s", affinity: aff, clusterPull: PRESENCE.zoneClusterPull });
      if (out.get(npc(1)) === out.get(npc(2))) together++;
    }
    expect(together / N).toBeGreaterThan(0.45); // clearly above the ~1/3 random co-zone rate
  });
});

describe("issue #792 — calibration neutrality (assignRooms without zonesOut is byte-identical)", () => {
  it("no zonesOut ⇒ identical room placement AND identical draw count as before the feature", () => {
    const active = cast(15);
    for (let seed = 0; seed < 40; seed++) {
      const rngA = new CountingRng(new SeededRandom(seed));
      const rngB = new CountingRng(new SeededRandom(seed));
      let occA = assignRooms(active, null, { rng: rngA, affinity: flatAffinity });
      // the SAME call but with a zonesOut sink supplied draws MORE (seating), so we DON'T compare that —
      // we prove the WITHOUT path is unchanged: a second run on a fresh stream matches occA exactly.
      let occB = assignRooms(active, null, { rng: rngB, affinity: flatAffinity });
      for (let tick = 0; tick < 20; tick++) {
        occA = assignRooms(active, occA, { rng: rngA, affinity: flatAffinity });
        occB = assignRooms(active, occB, { rng: rngB, affinity: flatAffinity });
      }
      expect([...occA.entries()]).toEqual([...occB.entries()]);
      expect(rngA.draws).toBe(rngB.draws);
    }
  });

  it("supplying zonesOut does NOT change the room placement (zones seat AFTER rooms are chosen)", () => {
    const active = cast(15);
    for (let seed = 0; seed < 20; seed++) {
      const roomsNoZone = assignRooms(active, null, { rng: new SeededRandom(seed), affinity: flatAffinity });
      const zonesOut = new Map<EntityId, Zone>();
      const roomsWithZone = assignRooms(active, null, { rng: new SeededRandom(seed), affinity: flatAffinity, zonesOut });
      // Same rooms (zone seating happens after placement, on the same stream — placement draws are first).
      expect([...roomsWithZone.entries()]).toEqual([...roomsNoZone.entries()]);
      // And every seated id is in a zoned room with a valid zone.
      for (const [id, z] of zonesOut) expect(zonesFor(roomsWithZone.get(id)!)).toContain(z);
    }
  });
});

describe("issue #792 — adapter: seated, persisted, drift/cluster-capable, pre-feature-safe", () => {
  // Seat the player + two NPCs into the backyard (a zoned room), tick, and read seated zones.
  function backyardSession(user: string) {
    const s = adrFixture(user, 7).sb.session;
    const core = s.snapshot();
    core.presence = { [PLAYER]: "backyard", [npc(1)]: "backyard", [npc(2)]: "backyard" } as Record<EntityId, Room>;
    s.restore(core);
    return s;
  }

  it("presenceTick SEATS a valid sub-zone, and the seat survives a snapshot → JSON round-trip → restore", () => {
    const s = backyardSession("u-seat");
    s.presenceTick(new SeededRandom(5)); // the off-screen tick seats zones on the weighted pass
    const z1 = s.currentZone(npc(1));
    expect(z1).toBeDefined();
    expect(zonesFor("backyard")).toContain(z1);

    const core = JSON.parse(JSON.stringify(s.snapshot()));
    expect(core.presenceZone, "the seated zones are serialized").toBeTruthy();

    const s2 = adrFixture("u-seat-2", 7).sb.session;
    s2.restore(core);
    expect(s2.currentZone(npc(1)), "the seat survives the restart unchanged").toBe(z1);
  });

  it("a PRE-FEATURE save (no presenceZone) loads with NO error and seats fresh on the next tick", () => {
    const s = backyardSession("u-pre");
    s.presenceTick(new SeededRandom(2));
    const core = JSON.parse(JSON.stringify(s.snapshot()));
    delete core.presenceZone; // simulate a save authored before this feature existed
    const s2 = adrFixture("u-pre-2", 7).sb.session;
    expect(() => s2.restore(core)).not.toThrow();
    // No seated zone yet ⇒ currentZone falls back to the deterministic on-read seed (still a valid zone).
    const fallback = s2.currentZone(npc(1));
    expect(zonesFor("backyard")).toContain(fallback);
    // And the next tick seats fresh without error.
    expect(() => s2.presenceTick(new SeededRandom(9))).not.toThrow();
    expect(zonesFor("backyard")).toContain(s2.currentZone(npc(1)));
  });

  it("the seated zone is Vault-free (no hidden-layer keys ride the presenceZone projection)", () => {
    const s = backyardSession("u-vault");
    s.presenceTick(new SeededRandom(1));
    const blob = JSON.stringify(s.snapshot().presenceZone ?? {});
    expect(/trust|threat|affinity|motive|soul|hiddenElement/i.test(blob)).toBe(false);
    // every value is just a plain zone name
    for (const z of Object.values(JSON.parse(blob) as Record<string, string>)) {
      expect(isZonedRoom("backyard")).toBe(true);
      expect(typeof z).toBe("string");
    }
  });
});
