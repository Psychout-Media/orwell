import { describe, it, expect } from "vitest";
import { chooseHourAction, floorRoutinesFor, routinesFromHabits, type HourView } from "../../src/engine/houseLife";
import { addRoutines, isStressed, noteSighting, routineKey, routineNow, type RoutineSightings } from "../../src/engine/routineLife";
import { ROUTINES, type Routine } from "../../src/engine/routines";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-651 / spec 0209 (the build): routines shape where someone is and what they do. Roles only. */
const HOLDER = "npc:1", OTHER = "npc:2";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
const strong: Routine = { slot: "evening", place: "backyard", action: "sunbathe", company: "alone", strength: 1, source: "floor" };
const hv = (over: Partial<HourView> = {}): HourView => ({
  owner: HOLDER, character: char, agenda: undefined, habits: [], routines: [strong], emotional: 0.6, room: "living-room",
  whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [OTHER, "living-room"]]), affinity: new Map([[OTHER, 0.7]]), threat: new Map(),
  mates: [], nominees: [], timeOfDay: "evening", day: 3, hour: 19, inCompetition: false, candor: 0.7, ...over,
});
const days = (v: HourView, n = 400) => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, day: 3 + Math.floor(i / 4), hour: 18 + (i % 4) }, 500 + i));
const share = (ps: ReturnType<typeof days>) => ps.filter((p) => p.routine === routineKey(strong) && p.place === "backyard").length / ps.length;

describe("0209: a routine decides where someone usually is", () => {
  it("a strong evening routine puts them in its room most evenings, doing it; only at its time", () => {
    const s = share(days(hv()));
    expect(s).toBeGreaterThan(0.45);
    expect(s).toBeLessThan(0.85);
    expect(share(days(hv({ timeOfDay: "morning" })))).toBe(0);
  });
  it("on the block or low they keep it less often", () => {
    const calm = share(days(hv()));
    expect(share(days(hv({ nominees: [HOLDER] })))).toBeLessThan(calm * 0.8);
    expect(share(days(hv({ emotional: 0.2 })))).toBeLessThan(calm * 0.8);
    expect(isStressed(0.6, true)).toBe(true);
  });
  it("the same inputs give the same day (keyed, no shared draw)", () => {
    expect(days(hv(), 60)).toEqual(days(hv(), 60));
  });
  it("company is only whoever is already there; a regular is the closest bond if they are there", () => {
    const there = new Map<string, Room>([[HOLDER, "living-room"], [OTHER, "backyard"]]);
    const withRegular = days(hv({ routines: [{ ...strong, company: "a-regular", action: "work-out" }], whereabouts: there })).filter((p) => p.routine);
    expect(withRegular.length).toBeGreaterThan(0);
    expect(withRegular.every((p) => p.with.every((w) => w === OTHER))).toBe(true);
    const away = days(hv({ routines: [{ ...strong, company: "whoever", action: "work-out" }] })).filter((p) => p.routine);
    expect(away.every((p) => p.with.length === 0)).toBe(true);
  });
  it("routineNow picks the strongest at the time; none at another time", () => {
    const weak = { ...strong, strength: 0.2, place: "kitchen" as Room };
    expect(routineNow([weak, strong], "evening", false, () => 0)).toBe(strong);
    expect(routineNow([weak, strong], "night", false, () => 0)).toBeUndefined();
  });
});

describe("0209: routines come from who the houseguest is", () => {
  it("two to four per houseguest, each a different act, each a time, a place and an act; deterministic; many different compositions", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const rs = floorRoutinesFor(char, `npc:${seed}`, seed);
      expect(rs.length).toBeGreaterThanOrEqual(ROUTINES.perPerson.min);
      expect(rs.length).toBeLessThanOrEqual(ROUTINES.perPerson.max);
      expect(new Set(rs.map((r) => r.action)).size).toBe(rs.length);
      expect(floorRoutinesFor(char, `npc:${seed}`, seed)).toEqual(rs);
      for (const r of rs) seen.add(routineKey(r));
    }
    expect(seen.size).toBeGreaterThan(40);
  });
  it("an authored habit from an older save keeps its own act and a time it belongs to", () => {
    const rs = routinesFromHabits(["gym-rat", "napper"], HOLDER, 4);
    expect(rs.map((r) => r.action)).toEqual(["work-out", "nap"]);
    expect(rs[0]!.slot === "morning" || rs[0]!.slot === "afternoon").toBe(true);
    expect(rs[1]!.slot).toBe("afternoon");
    expect(rs.every((r) => r.source === "authored")).toBe(true);
  });
  it("stored routines are kept: never replaced or thinned", () => {
    const store: Record<string, Routine[]> = {};
    const first = addRoutines(store, HOLDER, [strong]);
    expect(addRoutines(store, HOLDER, [])).toBe(first);
    expect(JSON.parse(JSON.stringify(store))[HOLDER]).toEqual([strong]);
  });
});

describe("0209: learned by sight on separate days", () => {
  it("known on the third separate day, never on repeats of one day", () => {
    const st: RoutineSightings = {};
    const k = routineKey(strong);
    expect(noteSighting(st, HOLDER, k, 1).learned).toBe(false);
    expect(noteSighting(st, HOLDER, k, 1).learned).toBe(false);
    expect(noteSighting(st, HOLDER, k, 2).learned).toBe(false);
    expect(noteSighting(st, HOLDER, k, 3).learned).toBe(true);
    expect(noteSighting(st, HOLDER, k, 4).learned).toBe(false);
  });
});

describe("0209 in a played game", () => {
  async function play(user: string, seed: number, off = false) {
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    const session = reg.sandboxFor(user).session as GameSessionAdapter;
    if (off) session.setRoutinesEnabled(false);
    for (let i = 0; i < 90; i++) await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    return { mcp, live: (session as unknown as { live: { routines?: Record<string, Routine[]>; routineSightings?: unknown } }).live };
  }
  it("each houseguest in the house gets routines, kept for the season; flag off = none", async () => {
    const on = await play("rt-a", 3);
    const ids = Object.keys(on.live.routines ?? {});
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(on.live.routines![id]!.length).toBeGreaterThanOrEqual(2);
    const off = await play("rt-b", 3, true);
    expect(off.live.routines).toBeUndefined();
  }, 120_000);
  it("the player knows a routine as a third-person fact only after seeing it on three separate days", async () => {
    const reg = composeRuntime({ clock: new FakeClock(), seed: 9 }).registry;
    const mcp = reg.resolver()("player", "rt-d");
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 9, archetype: "floater" });
    await mcp.callTool("noteMessage", { messageId: "rt-d-0" });
    const session = reg.sandboxFor("rt-d").session as unknown as { live: { routines?: Record<string, Routine[]>; routineSightings?: Record<string, Record<string, number[]>> }; noteRoutineSighting(p: unknown, day: number, k: unknown): void };
    const actor = Object.keys(session.live.routines ?? {})[0] ?? "npc:x";
    (session.live.routines ??= {})[actor] = [{ ...strong, gist: "stargazing like back on the farm" }];
    const told: string[] = [];
    const knowledge = { knownTo: () => [], seedBelief: (_e: string, f: { content: string }) => { told.push(f.content); return f; } };
    const step = { actor, kind: "sunbathe", place: "backyard", routine: routineKey(strong) };
    for (const day of [1, 1, 2]) session.noteRoutineSighting(step, day, knowledge);
    expect(told).toEqual([]);
    session.noteRoutineSighting(step, 3, knowledge);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("stargazing like back on the farm");
    expect(told[0]).toContain("backyard");
  }, 120_000);
  it("wall sentinel: no routine record or sighting reaches the player's reads", async () => {
    const { mcp, live } = await play("rt-c", 5);
    expect(Object.keys(live.routines ?? {}).length).toBeGreaterThan(0);
    let read = 0;
    for (const tool of ["whereabouts", "getVisibleState", "getKnowledge"]) {
      let out: unknown; try { out = await mcp.callTool(tool, {}); } catch { continue; }
      read++;
      const text = JSON.stringify(out);
      expect(text).not.toContain("routineSightings");
      expect(text).not.toContain('"source":"floor"');
      expect(text).not.toContain('"company"');
    }
    expect(read).toBeGreaterThan(0);
  }, 120_000);
});
