import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { TimeOfDay } from "../../src/engine/timeOfDay";
import { PLAYER } from "../../src/domain/ids";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameEvent } from "../../src/domain/event";
import type { BbWorld } from "../support/world";

// Feature 0192 (ORW-620). Roles only. The planner is pure, so the scenarios drive `chooseHourAction` over many seeded hours; the wall scenario uses a real sandbox.
const HOLDER = "npc:1", UP_A = "npc:2", UP_B = "npc:3";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
let base: HourView;
let sb: UserSandbox | undefined;
const SENTINEL = "SENTINEL-0192-late-night-hidden-talk";

const view = (over: Partial<HourView> = {}): HourView => ({
  owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
  whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [UP_A, "kitchen"], [UP_B, "kitchen"]]),
  affinity: new Map([[UP_A, 0.7], [UP_B, 0.5]]), threat: new Map(), mates: [], nominees: [], timeOfDay: "late-night", day: 3, hour: 26, inCompetition: false, candor: 0.7,
  nightOwl: { playerUp: false }, ...over,
});
const run = (v: HourView, n = 500, tod: TimeOfDay = "late-night"): PlannedAction[] =>
  Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, timeOfDay: tod, day: 3 + Math.floor(i / 8), hour: 20 + (i % 8) }, 2000 + i));
const owls = (ps: PlannedAction[]): PlannedAction[] => ps.filter((p) => p.nightOwl);

Given("night owls: a houseguest who is free late at night with two others still awake", function () { base = view(); });
Given("night owls: a houseguest who is free late at night and only one other houseguest is awake", function () {
  base = view({ whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [UP_A, "kitchen"]]), affinity: new Map([[UP_A, 0.7]]) });
});
Given("night owls: a houseguest who is free late at night and the only other one up is the player", function () {
  base = view({ whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [PLAYER, "kitchen"]]), affinity: new Map([[PLAYER, 0.9]]) });
});

Then("night owls: across seasons some of their free hours become a late-night talk, a bounded share, with someone who is awake and where that person is", function () {
  const ps = run(base);
  const share = owls(ps).length / ps.length;
  assert.ok(share > 0.1 && share < 0.45, `share ${share}`);
  for (const p of owls(ps)) {
    assert.ok(p.with.length > 0 && p.with.every((x) => x === UP_A || x === UP_B), "partner is awake");
    assert.equal(p.place, "kitchen");
  }
});
Then("night owls: by day, or in a crowded house, no hour is a late-night talk", function () {
  assert.equal(owls(run(base, 300, "afternoon")).length, 0);
  const crowd = new Map<string, Room>([[HOLDER, "living-room"], ...Array.from({ length: 8 }, (_, i) => [`npc:${10 + i}`, "kitchen"] as [string, Room])]);
  assert.equal(owls(run({ ...base, whereabouts: crowd, affinity: new Map() })).length, 0);
});
Then("night owls: every late-night talk is with that one houseguest", function () {
  const o = owls(run(base));
  assert.ok(o.length > 0);
  for (const p of o) assert.deepEqual(p.with, [UP_A]);
});
Then("night owls: with nobody else awake there is no late-night talk at all", function () {
  assert.equal(owls(run({ ...base, whereabouts: new Map<string, Room>([[HOLDER, "living-room"]]), affinity: new Map() })).length, 0);
});
Then("night owls: across seasons the talks include confessions, clashes and bonding, and a third houseguest can join", function () {
  const sad = owls(run({ ...base, emotional: 0.3 }));
  const rub = owls(run({ ...base, emotional: 0.45, affinity: new Map([[UP_A, 0.1], [UP_B, 0.1]]) }));
  const calm = owls(run(base));
  const kinds = new Set([...sad, ...rub, ...calm].map((p) => p.kind));
  assert.ok(kinds.has("homesick-talk") && kinds.has("confront") && (kinds.has("bed-talk") || kinds.has("tell-stories")), [...kinds].join(","));
  assert.ok(calm.some((p) => p.with.length === 2), "a trio forms");
});
Then("night owls: when the player is up the houseguest sometimes seeks them out, and when the player has turned in never", function () {
  const up = owls(run({ ...base, nightOwl: { playerUp: true } }));
  assert.ok(up.length > 0 && up.every((p) => p.with.includes(PLAYER)));
  assert.equal(owls(run({ ...base, nightOwl: { playerUp: false } })).length, 0);
});

Given("night owls: a late-night talk the player was not part of", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  sb = reg.sandboxFor("night-owls-wall");
  sb.session.createCharacter({ playerName: "Player", seed: 5 });
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER).slice(0, 2);
  const ev: GameEvent = {
    id: "offscreen:bonding:night-owl-0192", ts: 1, type: "bonding", initiator: npcs[0]!, witnessSet: npcs, hidden: true, content: SENTINEL, baseContent: SENTINEL,
    houseLife: { nightOwl: true, action: "bed-talk", place: "kitchen", manner: "warm", truthful: true, stretch: 1 },
  };
  sb.engine.events.record(ev);
  assert.ok(sb.engine.events.queryAll().some((e) => e.content === SENTINEL), "positive control: the engine holds the talk");
});
Then("night owls: no player surface and no admin surface shows it", function () {
  const s = sb!;
  const surfaces = [JSON.stringify(s.session.getGameState()), JSON.stringify(s.player.getVisibleState()), JSON.stringify(s.session.getMomentPrompt({})),
    JSON.stringify(s.session.getMomentPrompt({ moment: "social" })), JSON.stringify(s.engine.knowledge.knownTo(PLAYER))];
  for (const x of surfaces) assert.ok(!x.includes("SENTINEL-0192"), "a late-night talk leaked onto a player surface");
  s.syncAdmin();
  const admin = JSON.stringify(s.session.gameStatus()) + JSON.stringify(s.admin.inspect());
  assert.ok(!admin.includes("SENTINEL-0192"), "a late-night talk leaked onto the admin surface");
});
Then("night owls: with the feature off no hour is a late-night talk", function () {
  const { nightOwl: _drop, ...off } = base; void _drop;
  assert.equal(owls(run(off as HourView)).length, 0);
});
