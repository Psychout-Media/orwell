import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionAdapter as Adapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { headcountLines } from "../../src/engine/momentPrompts";
import { linger } from "../support/linger";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-386: "Look for Miguel. Where is he?" - the house search hands the narrator each houseguest's ROOM (and whether the player can walk in), and the headcounts. Roles only. */
let n = 0;
function fresh(seed = 1): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`hs386-${n++}`).session;
  s.createCharacter({ playerName: "P", seed });
  return s;
}
function toNominations(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = fresh(seed);
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (s.getGameState().phase === "nominations" && s.livingIds().length >= 14) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("never");
}
type Hack = { presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; ceremony: { hoh?: EntityId } };

/** Day 2 morning: 11 asleep, one in the backyard with the player, one in the living room, two awake in `hidden` (bedroom A, or the HOH room). */
function stage(hidden: string): { s: GameSessionAdapter; npcs: EntityId[] } {
  const s = toNominations();
  const npcs = s.livingIds().filter((id) => id !== PLAYER).slice(0, 15);
  expect(npcs.length).toBeGreaterThanOrEqual(15);
  const h = s as unknown as Hack;
  const asleep = npcs.slice(0, 11);
  const [inYard, inLiving, h1, h2] = npcs.slice(11);
  const beds = ["bedroom-a", "bedroom-b", "bedroom-c"];
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], [inYard!, "backyard"], [inLiving!, "living-room"], [h1!, hidden], [h2!, hidden]];
  asleep.forEach((id, i) => seats.push([id, beds[i % 3]!]));
  // every other living NPC (beyond the 15 staged) is asleep in a bed too
  for (const id of s.livingIds()) if (id !== PLAYER && !seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  const up = new Set<EntityId>([PLAYER, inYard!, inLiving!, h1!, h2!]);
  h.awakeNow = () => up;
  h.ceremony.hoh = npcs[0]; // someone else holds the crown
  return { s, npcs };
}

describe("ORW-386 house search (engine)", () => {
  it("two awake houseguests in a bedroom: the search names the bedroom and says it is open", () => {
    const { s, npcs } = stage("bedroom-a");
    const [, , , , , , , , , , , , , h1, h2] = npcs;
    const wa = s.whereabouts({ search: true })!;
    // the bug: neither is in any listed room, so the plain view has nothing to say about them
    const listed = [...wa.present, ...wa.nearby.flatMap((r) => r.present)].map((p) => p.id);
    expect(listed).not.toContain(h1);
    expect(listed).not.toContain(h2);
    const find = (id: EntityId) => wa.search!.houseguests.find((e) => e.id === id)!;
    for (const id of [h1!, h2!]) {
      expect(find(id)).toMatchObject({ status: "awake", room: "bedroom-a", access: "open" });
      expect(find(id).fact).toContain("bedroom A");
    }
    expect(find(npcs[11]!)).toMatchObject({ status: "here", room: "backyard" });
    expect(find(npcs[12]!)).toMatchObject({ status: "awake", room: "living-room" });
    expect(find(npcs[0]!).status).toBe("asleep");
    expect(find(npcs[0]!).fact).toMatch(/^asleep in bedroom [ABC]$/);
  });

  it("the two in the HOH room: 'HOH room, door closed'", () => {
    const { s, npcs } = stage("hoh-room");
    const wa = s.whereabouts({ search: true })!;
    for (const id of [npcs[13]!, npcs[14]!]) {
      const e = wa.search!.houseguests.find((x) => x.id === id)!;
      expect(e.fact).toBe("HOH room, door closed");
      expect(e.access).toBe("closed");
    }
    expect(wa.search!.rooms.find((r) => r.room === "hoh-room")).toMatchObject({ access: "closed" });
  });

  it("the HOH room is open to the player when the player holds the crown", () => {
    const { s, npcs } = stage("hoh-room");
    (s as unknown as Hack).ceremony.hoh = PLAYER;
    const e = s.whereabouts({ search: true })!.search!.houseguests.find((x) => x.id === npcs[13])!;
    expect(e.access).toBe("open");
  });

  it("asleep = 11 and the living room roster = that houseguest, in the counts and the narrator's terminal block", () => {
    const { s, npcs } = stage("bedroom-a");
    const wa = s.whereabouts()!;
    expect(wa.search).toBeUndefined(); // only on a search turn
    expect(wa.counts!.asleep).toBe(11);
    expect(wa.search ?? s.whereabouts({ search: true })!.search!.asleepCount).toBe(11);
    const living = wa.nearby.find((r) => r.room === "living-room")!;
    expect(living.present.map((p) => p.id)).toEqual([npcs[12]]);
    const hc = s.getMomentPrompt({}).hardConstraints ?? "";
    expect(hc).toContain("Asleep right now: 11 houseguests have turned in");
    expect(hc).toContain(`living room: ${living.present[0]!.name}`);
    expect(hc).toContain("kitchen: empty");
  });

  it("headcountLines: asleep and the rooms in view, and nothing extra when the view lacks them", () => {
    const l = headcountLines({ counts: { room: 2, others: 1, house: 16, asleep: 11 }, nearby: [{ room: "living-room", present: [{ name: "Jett Wooten" }] }, { room: "kitchen", present: [] }] }).join("\n");
    expect(l).toContain("Asleep right now: 11 houseguests");
    expect(l).toContain("Rooms in view right now: living room: Jett Wooten; kitchen: empty");
    expect(headcountLines({ counts: { room: 1, others: 0, house: 3 } }).join("\n")).not.toContain("Asleep");
  });

  it("is a read: a search leaves the state identical", () => {
    const { s } = stage("bedroom-a");
    const a = JSON.stringify(s.getGameState());
    s.whereabouts({ search: true }); s.whereabouts({ search: true });
    expect(JSON.stringify(s.getGameState())).toBe(a);
  });

  it("carries no Vault field: only room, access, status, name, id and the ready sentence", () => {
    const { s } = stage("hoh-room");
    const sv = s.whereabouts({ search: true })!.search!;
    expect(Object.keys(sv).sort()).toEqual(["asleepCount", "houseguests", "rooms"]);
    for (const e of sv.houseguests) expect(Object.keys(e).every((k) => ["id", "name", "status", "room", "access", "fact"].includes(k))).toBe(true);
    for (const r of sv.rooms) expect(Object.keys(r).sort()).toEqual(["access", "present", "room"]);
    expect(JSON.stringify(sv)).not.toMatch(/secret|vault|soul|suspic|affinity|trust|plot|scheme/i);
  });
});

describe("ORW-386 invariant: every living houseguest is somewhere", () => {
  it("each living NPC is seated in exactly one room, and the search lists each exactly once (asleep or in a room), across seeds and a night", () => {
    Adapter.setTimeOfDayEnabled(true);
    try {
      for (const seed of [3, 5, 8, 13, 21]) {
        const s = fresh(seed);
        for (let i = 0; i < 40; i++) {
          const v = s.advanceGame();
          if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
          if (i % 5 === 0) linger(s);
          const wa = s.whereabouts({ search: true });
          if (!wa?.search) continue;
          const pres = (s as unknown as Hack).presence;
          const ids = wa.search.houseguests.map((e) => e.id);
          expect(new Set(ids).size, `seed ${seed} step ${i}: a houseguest listed twice`).toBe(ids.length);
          for (const id of s.livingIds()) {
            if (id === PLAYER || wa.houseEvent) continue;
            expect(pres.has(id), `seed ${seed} step ${i}: ${id} is in no room`).toBe(true);
          }
          if (!wa.houseEvent) {
            const living = s.livingIds().filter((id) => id !== PLAYER);
            const notArrived = living.filter((id) => !ids.includes(id));
            expect(notArrived, `seed ${seed} step ${i}: living houseguests the search lost`).toEqual([]);
          }
        }
      }
    } finally { Adapter.setTimeOfDayEnabled(null); }
  });
});

describe("ORW-386 live evidence 2026-11-15 00:02: two houseguests in no room, then one 'lingering 22 turns'", () => {
  type Pe = { live: { premiereEntrance?: { order: EntityId[]; arrived: number; stage: string } } };
  function atEntrances(leftOut: number): { s: GameSessionAdapter; late: EntityId[] } {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = new GameSessionRegistry().sandboxFor(`hs386-pe-${n++}`).session;
      s.setPremiereEntrancesEnabled(true);
      s.createCharacter({ playerName: "P", seed });
      const pe = () => (s as unknown as Pe).live.premiereEntrance;
      if (!pe() || pe()!.stage !== "entrances") continue;
      for (let i = 0; i < 40 && pe()?.stage === "entrances" && pe()!.arrived < pe()!.order.length - leftOut; i++) s.advanceGame();
      if (pe()?.stage === "entrances" && pe()!.arrived === pe()!.order.length - leftOut) return { s, late: pe()!.order.slice(pe()!.arrived).filter((id) => id !== PLAYER) };
    }
    throw new Error("no staged entrances to stop in");
  }

  it("the cause: houseguests who have not walked in yet are in NO room and not asleep, though the house count includes them; the search says so", () => {
    const { s, late } = atEntrances(2);
    expect(late.length).toBeGreaterThanOrEqual(1);
    const wa = s.whereabouts({ search: true })!;
    const listed = [...wa.present, ...wa.nearby.flatMap((r) => r.present)].map((p) => p.id);
    const asleep = (s.getGameState() as { asleep?: Array<{ id: EntityId }> }).asleep ?? [];
    for (const id of late) {
      expect(listed).not.toContain(id); // the plain view cannot find them (by design: A9)
      expect(asleep.map((a) => a.id)).not.toContain(id);
      const e = wa.search!.houseguests.find((x) => x.id === id)!;
      expect(e.status).toBe("arriving");
      expect(e.fact).toContain("has not walked into the house yet");
      expect(e.room).toBeUndefined();
    }
    expect(wa.counts!.house).toBeGreaterThan(wa.search!.houseguests.filter((x) => x.status !== "arriving").length); // the count still includes them
  });

  it("a houseguest who walks in has been in the room no turns, however long the engine seated them there", () => {
    const { s, late } = atEntrances(1);
    const id = late[0]!;
    const h = s as unknown as { presenceTenure: Map<EntityId, number> };
    h.presenceTenure = new Map([[id, 22]]); // the tenure kept counting while they were held outside
    s.advanceGame(); // their entrance
    expect(h.presenceTenure.get(id)).toBe(0);
  });

  it("someone who has turned in is not also 'tracked' behind the HOH room door", () => {
    const { s, npcs } = stage("bedroom-a");
    const gwen = npcs[0]!; // asleep in the staged morning
    const h = s as unknown as { trackedSightings: Map<EntityId, unknown>; presenceTickCount: number };
    h.trackedSightings = new Map([[gwen, { room: "hoh-room", tick: h.presenceTickCount - 5, pathway: "watched", confidence: 1 }]]) as never;
    expect(s.whereabouts()!.tracked.map((t) => t.id)).not.toContain(gwen);
    // ...and the belief is read again once they are up (kept, not deleted)
    const up = new Set<EntityId>([PLAYER, gwen]);
    (s as unknown as Hack).awakeNow = () => up;
    expect(s.whereabouts()!.tracked.map((t) => t.id)).toContain(gwen);
  });
});
