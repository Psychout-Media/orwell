import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { chooseHourAction, floorRoutinesFor, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import { noteSighting, routineKey, type RoutineSightings } from "../../src/engine/routineLife";
import { ROUTINES, type Routine } from "../../src/engine/routines";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// Feature 0209 (ORW-651). Roles only. The planner is pure, so the scenarios drive `chooseHourAction` over many seeded hours; the wall scenario plays a real sandbox.
const HOLDER = "npc:1", FRIEND = "npc:2";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
const evening: Routine = { slot: "evening", place: "backyard", action: "work-out", company: "whoever", strength: 1, source: "floor" };
let base: HourView;
const view = (over: Partial<HourView> = {}): HourView => ({
  owner: HOLDER, character: char, agenda: undefined, habits: [], routines: [evening], emotional: 0.6, room: "living-room",
  whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [FRIEND, "living-room"]]), affinity: new Map([[FRIEND, 0.8]]), threat: new Map(),
  mates: [], nominees: [], timeOfDay: "evening", day: 3, hour: 19, inCompetition: false, candor: 0.7, ...over,
});
const run = (v: HourView, n = 400): PlannedAction[] => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, day: 3 + Math.floor(i / 4), hour: 18 + (i % 4) }, 700 + i));
const keeps = (ps: PlannedAction[]): number => ps.filter((p) => p.routine === routineKey(evening) && p.place === "backyard").length / ps.length;

Given("habits: a cast of houseguests of one archetype", function () { base = view(); });
Then("habits: each houseguest has two to four routines at different times of day, each a time, a place and an act", function () {
  for (let seed = 1; seed <= 30; seed++) {
    const rs = floorRoutinesFor(char, `npc:${seed}`, seed);
    assert.ok(rs.length >= ROUTINES.perPerson.min && rs.length <= ROUTINES.perPerson.max);
    assert.equal(new Set(rs.map((r) => r.slot)).size, rs.length);
    assert.ok(rs.every((r) => r.place && r.action));
  }
});
Then("habits: the same houseguest always composes the same routines, and the cast shares no fixed menu", function () {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const a = floorRoutinesFor(char, `npc:${seed}`, seed);
    assert.deepEqual(floorRoutinesFor(char, `npc:${seed}`, seed), a);
    for (const r of a) seen.add(routineKey(r));
  }
  assert.ok(seen.size > 40, `distinct routines: ${seen.size}`);
});

Given("habits: a houseguest with a strong evening routine in the backyard", function () { base = view(); });
Then("habits: across days they are in the backyard most evenings, doing it, and never at another time of day", function () {
  const s = keeps(run(base));
  assert.ok(s > 0.45 && s < 0.85, `share ${s}`);
  assert.equal(keeps(run(view({ timeOfDay: "morning" }))), 0);
});
Then("habits: when they are on the block or low, they keep it less often", function () {
  const calm = keeps(run(base));
  assert.ok(keeps(run(view({ nominees: [HOLDER] }))) < calm * 0.8);
  assert.ok(keeps(run(view({ emotional: 0.2 }))) < calm * 0.8);
});

Given("habits: a houseguest with a strong evening routine in the backyard and a close friend elsewhere", function () { base = view(); });
Then("habits: they never pull the friend in from another room", function () {
  const kept = run(base).filter((p) => p.routine);
  assert.ok(kept.length > 0);
  assert.ok(kept.every((p) => !p.with.includes(FRIEND)));
});

let sightings: RoutineSightings;
Given("habits: the player has seen a houseguest keep a routine on separate days", function () { sightings = {}; });
Then("habits: the third separate day makes it something the player knows, and repeats within one day do not", function () {
  const k = routineKey(evening);
  assert.equal(noteSighting(sightings, HOLDER, k, 1).learned, false);
  assert.equal(noteSighting(sightings, HOLDER, k, 1).learned, false);
  assert.equal(noteSighting(sightings, HOLDER, k, 2).learned, false);
  assert.equal(noteSighting(sightings, HOLDER, k, 3).learned, true);
});

type Live = { routines?: Record<string, Routine[]> };
const played: Record<string, { live: Live; texts: string[] }> = {};
async function play(user: string, off: boolean): Promise<void> {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 5 }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5, archetype: "floater" });
  const session = reg.sandboxFor(user).session as GameSessionAdapter;
  if (off) session.setRoutinesEnabled(false);
  for (let i = 0; i < 60; i++) await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
  const texts: string[] = [];
  for (const tool of ["whereabouts", "getVisibleState"]) { try { texts.push(JSON.stringify(await mcp.callTool(tool, {}))); } catch { /* not a tool here */ } }
  played[user] = { live: (session as unknown as { live: Live }).live, texts };
}
Given("habits: a played game with routines on and one with them off", async function () { await play("habits-on", false); await play("habits-off", true); });
Then("habits: no player read shows a routine record or a sighting", function () {
  const { live, texts } = played["habits-on"]!;
  assert.ok(Object.keys(live.routines ?? {}).length > 0);
  assert.ok(texts.length > 0);
  for (const t of texts) { assert.ok(!t.includes("routineSightings")); assert.ok(!t.includes('"source":"floor"')); assert.ok(!t.includes('"company"')); }
});
Then("habits: with the feature off no houseguest has routines", function () { assert.equal(played["habits-off"]!.live.routines, undefined); });
