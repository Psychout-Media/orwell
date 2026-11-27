import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { HOUSE_ADJACENCY, type Room } from "../../src/domain/house";

/**
 * ORW-934 (Kevin 2026-11-26): "look for X" is an engine action that plays out room by room. No teleport either way; X is only where the engine has X (and may move); tips come from recorded sightings and may be stale;
 * the search ends when X is found or X is somewhere the player cannot go. The REAL path: resolvePlayerMove on the player's words, the real clock, the real movement tick (only the other houseguests' random drift is pinned so the placements are exact).
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Priv = {
  presence: Map<string, string>;
  house: { player: { id: string } };
  live: { nightDepth?: number; champagneCircle?: unknown; timeOfDay?: string; dayNumber?: number };
  lastSeenAt: Map<string, { room: string; tick: number; day: number; part: string }> | null;
  presenceTick(rng?: unknown): void;
  nameOf(id: string): string;
  livingIds(): string[];
};

function start() {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const rt = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orw934-"))), clock: new FakeClock() });
  const s = rt.registry.sandboxFor("srch934").session;
  s.createCharacter({ playerName: "P", seed: 11 });
  const p = s as unknown as Priv;
  p.live.champagneCircle = undefined;
  s.movePlayer("living-room");
  const others = p.livingIds().filter((id) => id !== p.house.player.id);
  const x = others[0]!;
  const firstName = p.nameOf(x).split(" ")[0]!;
  // script: per movement tick, where the target stands (the rest of the house is parked on the landing); a tick past the script keeps the last placement
  let tick = 0;
  let script: string[] = [];
  const orig = p.presenceTick.bind(p);
  p.presenceTick = (rng?: unknown) => {
    orig(rng);
    others.forEach((id) => p.presence.set(id, PARK));
    p.presence.set(x, script[Math.min(tick, script.length - 1)]!);
    tick += 1;
  };
  const clock = { atSearch: undefined as number | undefined };
  return {
    s, p, x, firstName, clock,
    /** X's room at each leg's tick (index 0 = before the first leg), and a recorded sighting of X by the player. */
    plan(rooms: string[], seenIn?: string) {
      script = rooms; tick = 0;
      others.forEach((id) => p.presence.set(id, PARK));
      p.presence.set(x, rooms[0]!);
      p.lastSeenAt = seenIn ? new Map([[x, { room: seenIn, tick: 0, day: p.live.dayNumber ?? 1, part: p.live.timeOfDay ?? "" }]]) : null;
    },
    say(text: string) {
      s.noteMessage({ messageId: `m${++n}` });
      clock.atSearch = p.live.nightDepth; // the clock as the message's own step left it, just before the search walks
      others.forEach((id) => p.presence.set(id, PARK));
      p.presence.set(x, script[0]!); // the turn's own tick re-seats the house; the target stands where the plan puts them as the search begins
      return s.resolvePlayerMove({ text });
    },
  };
}
let n = 0;
/** the rest of the house is parked upstairs on the landing, a room no test route visits */
const PARK = "landing";
/** Every leg is one step into a room NEXT DOOR to the one before: nothing teleports. */
function expectNoTeleport(from: string, legs: Array<{ room: string }>, finalRoom: string): void {
  let at = from as Room;
  for (const l of legs) {
    expect(HOUSE_ADJACENCY.get(at) ?? [], `${at} -> ${l.room} is not a step between neighbouring rooms`).toContain(l.room);
    at = l.room as Room;
  }
  expect(finalRoom).toBe(at);
}

describe("ORW-934 searching for a houseguest plays out leg by leg", () => {
  it("X two rooms away is found in ONE message: the legs are listed, the player really walked there, the clock advanced", () => {
    const t = start();
    t.plan(["bedroom-a"], "hallway"); // last seen in the hallway, then went into bedroom A
    const r = t.say(`I look for ${t.firstName}`);
    const before = t.clock.atSearch;
    expect(before, "the clock is running").toBeTypeOf("number");
    expect(r.search?.outcome).toBe("found");
    expect(r.search!.legs.map((l) => l.room)).toEqual(["hallway", "bedroom-a"]);
    expect(r.search!.legs[0]!.why).toBe("sighting");
    expect(r.search!.legs[1]!.present.map((x) => x.id)).toEqual([t.x]);
    expect(r.playerMove).toMatchObject({ from: "living-room", to: "bedroom-a" });
    expect(t.s.whereabouts()!.room).toBe("bedroom-a");
    expect(t.p.live.nightDepth! - before!).toBeGreaterThan(0);
    expect(r.search!.minutes).toBe(6);
    expectNoTeleport("living-room", r.search!.legs, t.p.presence.get(t.p.house.player.id)!);
    const state = t.s.getGameState() as { playerSearch?: { legs: unknown[] } } | null;
    expect(state?.playerSearch?.legs).toHaveLength(2); // the narrator is handed the same legs, on this message only
  });

  it("'where is X' commits the same search", () => {
    const t = start();
    t.plan(["bedroom-a"], "hallway");
    const r = t.say(`Where is ${t.firstName}?`);
    expect(r.search?.outcome).toBe("found");
    expect(t.s.whereabouts()!.room).toBe("bedroom-a");
  });

  it("a stale tip is followed and the search CONTINUES (the player does not have to steer room by room)", () => {
    const t = start();
    t.plan(["bedroom-b"], "kitchen"); // seen in the kitchen earlier; now in bedroom B
    const r = t.say(`I go look for ${t.firstName}`);
    expect(r.search!.legs[0]).toMatchObject({ room: "kitchen", why: "sighting" });
    expect(r.search!.legs[0]!.present).toEqual([]); // not there: the tip was stale
    expect(r.search!.legs.length).toBeGreaterThan(2);
    expect(r.search!.outcome).toBe("found");
    expect(t.p.presence.get(t.p.house.player.id)).toBe("bedroom-b");
    expectNoTeleport("living-room", r.search!.legs, "bedroom-b");
  });

  it("X moves while the player walks: the search follows where X really is, never where they were", () => {
    const t = start();
    t.plan(["bedroom-a", "bedroom-a", PARK], "hallway"); // in bedroom A when the player sets out, in bedroom C two ticks later
    const r = t.say(`I look for ${t.firstName}`);
    expect(r.search!.outcome).toBe("found");
    const rooms = r.search!.legs.map((l) => l.room);
    expect(rooms[rooms.length - 1]).toBe(PARK);
    expect(rooms).toContain("bedroom-a"); // checked it, empty by then
    expect(r.search!.legs.find((l) => l.room === "bedroom-a")!.present).toEqual([]);
    expect(t.p.presence.get(t.x)).toBe(PARK);
    expectNoTeleport("living-room", r.search!.legs, PARK);
  });

  it("X in the Diary Room: the search ends with a plain reason, the player is not moved and no time is spent", () => {
    const t = start();
    t.plan(["diary-room"], "hallway");
    const r = t.say(`I look for ${t.firstName}`);
    expect(r.search?.outcome).toBe("closed-room");
    expect(r.search!.reason).toMatch(/Diary Room/);
    expect(r.search!.legs).toEqual([]);
    expect(t.s.whereabouts()!.room).toBe("living-room");
    expect(r.playerMove).toBeNull();
    expect(t.p.live.nightDepth).toBe(t.clock.atSearch); // only the message's own step: no leg time
  });

  it("the player can stop early: maxLegs ends it 'stopped' where the player is, with the legs so far", () => {
    const t = start();
    t.plan(["bedroom-b"], "kitchen");
    t.s.noteMessage({ messageId: `m${++n}` });
    t.p.livingIds().filter((id) => id !== t.p.house.player.id).forEach((id) => t.p.presence.set(id, PARK));
    t.p.presence.set(t.x, "bedroom-b");
    const res = t.s.searchForHouseguest({ name: t.firstName, maxLegs: 1 })!;
    expect(res.search.outcome).toBe("stopped");
    expect(res.search.legs).toHaveLength(1);
    expect(t.s.whereabouts()!.room).toBe("kitchen");
  });

  it("the walk never moves anyone but the player along the route: X is where the engine had X", () => {
    const t = start();
    t.plan(["storage-room"], "kitchen");
    const r = t.say(`find ${t.firstName}`);
    expect(r.search!.outcome).toBe("found");
    expect(t.p.presence.get(t.x)).toBe("storage-room");
    expect(t.p.presence.get(t.p.house.player.id)).toBe("storage-room");
  });

  it("with no sighting or tip the search sweeps the busy rooms first, then the bedrooms, then the quiet rooms (nearest first, none twice)", () => {
    const t = start();
    t.plan(["lounge"]); // no recorded sighting at all; X is in the lounge, a quiet room
    const r = t.say(`I look for ${t.firstName}`);
    const rooms = r.search!.legs.map((l) => l.room);
    expect(r.search!.outcome).toBe("found");
    expect(r.search!.legs.every((l) => l.why === "sweep")).toBe(true);
    expect(rooms[rooms.length - 1]).toBe("lounge");
    const tier = (x: string) => (["living-room", "kitchen", "dining-room", "backyard"].includes(x) ? 0 : x === "hallway" || x.startsWith("bedroom-") ? 1 : 2);
    const goals = rooms.filter((x) => !["living-room", "hallway"].includes(x)); // hubs are walked through on the way
    const tiers = goals.map(tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b)); // never a quiet room before a bedroom, nor a bedroom before the shared rooms
    expect(rooms).toContain("kitchen");
    expect(rooms).toContain("bedroom-a");
    expect(rooms.indexOf("kitchen")).toBeLessThan(rooms.indexOf("bedroom-a"));
    expect(rooms.indexOf("bedroom-a")).toBeLessThan(rooms.indexOf("lounge"));
    expectNoTeleport("living-room", r.search!.legs, "lounge");
  });
});
