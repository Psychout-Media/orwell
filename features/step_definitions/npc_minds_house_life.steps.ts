import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { chooseHourAction, foldOf, temperOf, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import { seedAgenda, recheckAgenda, mullAgenda, tieAvoids, type Agenda, type AgendaBoard, type AgendaCharacter, type AgendaView, type Goal } from "../../src/engine/agenda";
import { jurorArchetypeFor } from "../../src/engine/juryMinds";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";
import type { Room } from "../../src/domain/house";
import type { EntityId } from "../../src/domain/ids";
import { PLAYER } from "../../src/domain/ids";
import type { EdgeSignals } from "../../src/engine/relationshipConstants";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { startPlayedSandbox } from "../../tests/support/agendaSeasonDriver";

/**
 * FEATURE 0147 / ORW-339 - the theme 1 pieces that only had unit tests, stated in Ryne's terms. Every scenario drives the REAL runtime (a played season, a real per-user sandbox) or the real engine
 * functions the runtime calls; none re-implements a rule. Roles only: holder, target, rival, ally, HOH, juror.
 */
type World = { nm: Record<string, unknown> };
const nm = (w: unknown): Record<string, any> => ((w as World).nm ??= {}) as Record<string, any>;
After(function () { GameSessionAdapter.setTimeOfDayEnabled(false); });

// --- 1. house life: every awake houseguest acts once an hour, no stock scene -------------------------------------------------------
Given("a played season with the house awake", function () {
  const { s, sb } = startPlayedSandbox(5);
  Object.assign(nm(this), { s, sb });
});
When("the house lives through several hours", function () {
  const c = nm(this);
  const s = c.s as GameSessionAdapter, sb = c.sb;
  const live = (s as unknown as { live: { nightDepth?: number } }).live;
  const awake = s.livingIds();
  const stretches: Array<{ actors: string[]; scenes: Array<{ initiator: string; hasLife: boolean }> }> = [];
  for (let i = 0; i < 10; i++) {
    live.nightDepth = (live.nightDepth ?? 8) + 1; // the in-game hour moves on between stretches
    const scenes = s.houseLifeStretch(sb.engine.events, awake, i);
    stretches.push({ actors: scenes.map((x) => x.initiator), scenes: scenes.map((x) => ({ initiator: x.initiator, hasLife: x.event.houseLife !== undefined })) });
  }
  c.stretches = stretches;
});
Then("every awake houseguest outside the player's room acts at most once an hour", function () {
  const c = nm(this);
  assert.ok(c.stretches.some((x: { actors: string[] }) => x.actors.length > 0), "somebody acted");
  for (const st of c.stretches as Array<{ actors: string[] }>) assert.equal(new Set(st.actors).size, st.actors.length, "nobody acts twice in one hour");
});
Then("every scene they make is a house-life action, never a stock scene", function () {
  const c = nm(this);
  for (const st of c.stretches as Array<{ scenes: Array<{ hasLife: boolean }> }>) for (const sc of st.scenes) assert.ok(sc.hasLife, "a scene without a house-life record is a stock scene");
});

// --- shared: an hour view for the pure engine functions -------------------------------------------------------------------
const HOLDER = "npc:1", TARGET = "npc:3", FRIEND = "npc:4", VOTER = "npc:5", HOH = "npc:2";
const char = (archetype: Archetype, style: StrategyStyle = "social"): AgendaCharacter => ({ archetype, strategyStyle: style, secretKinds: [] });
const goal = (kind: Goal["kind"], target: string | undefined): Goal => ({
  id: `${HOLDER}:${kind}:${target ?? "-"}`, owner: HOLDER, horizon: "week", kind, ...(target ? { target } : {}), why: [{ kind: "character", weight: 1 }],
  test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1,
});
function hourView(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char("analyst"), agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [HOH, "hoh-room"], [TARGET, "kitchen"], [FRIEND, "living-room"], [VOTER, "backyard"], [PLAYER, "kitchen"]]),
    affinity: new Map([[FRIEND, 0.8], [VOTER, 0.6], [TARGET, 0.2], [HOH, 0.5], [PLAYER, 0.5]]), threat: new Map([[TARGET, 0.8]]), mates: [], nominees: [],
    timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  };
}
const hours = (v: HourView, n = 40): PlannedAction[] => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, hour: 8 + (i % 16), day: 3 + Math.floor(i / 16) }, 77));

// --- 2. a houseguest after a target confronts them when they share a room -----------------------------------------------------
Given("a holder who wants a target gone and shares a room with them", function () {
  nm(this).shared = new Map<string, Room>([[HOLDER, "kitchen"], [TARGET, "kitchen"], [FRIEND, "living-room"], [VOTER, "backyard"], [HOH, "hoh-room"]]);
});
When("the hours pass for a hothead and for a peacemaker", function () {
  const c = nm(this);
  const confronts = (k: Archetype): number => hours(hourView({ character: char(k), agenda: { owner: HOLDER, goals: [goal("get-them-out", TARGET)], history: [], formedForWeek: 1 }, hoh: HOH, room: "kitchen", whereabouts: c.shared, timeOfDay: "evening" }), 200)
    .filter((p) => p.kind === "confront" && p.with[0] === TARGET).length;
  c.hot = confronts("hothead"); c.calm = confronts("peacemaker");
});
Then("the hothead confronts the target on many hours", function () { assert.ok(nm(this).hot > 20, `a hothead confronted on ${nm(this).hot} hours`); });
Then("the peacemaker confronts them far less", function () {
  const c = nm(this);
  assert.ok(c.hot > c.calm * 3, `hothead ${c.hot} against peacemaker ${c.calm}`);
  assert.ok(temperOf(char("hothead")) > temperOf(char("peacemaker")));
});

// --- 3. recruiting folds as strategy until the alliance exists ----------------------------------------------------------------
Given("a holder pitching someone who is not their ally", function () {
  nm(this).plans = hours(hourView({ agenda: { owner: HOLDER, goals: [goal("pull-them-in", VOTER)], history: [], formedForWeek: 1 }, timeOfDay: "evening" }));
});
Then("the pitch counts as strategy talk", function () {
  const p = (nm(this).plans as PlannedAction[]).find((x) => x.kind === "pitch" || x.kind === "recruit")!;
  assert.ok(p, "the holder pitched or recruited");
  assert.equal(p.fold, "strategy");
  assert.equal(foldOf("pitch", VOTER, []), "strategy");
});
Then("the same pitch to an ally counts as alliance talk", function () { assert.equal(foldOf("recruit", VOTER, [VOTER]), "alliance"); });

// --- 4. a plan that works lifts the mood; the cause is told only to the trusted --------------------------------------------
type MoodS = {
  live: { week: number; active: EntityId[]; evictionOrder: EntityId[]; agendas?: Record<string, { goals: Goal[]; history: Goal[] }>; moodCauses?: Record<string, { outcome: string; line: string }> };
  agendaRecheck(trigger: string): void;
  npcVoice(id: EntityId): { moodCause?: string } | null;
  soulObj(id: EntityId): { emotionalHistory: unknown[] } | undefined;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number } };
};
Given("a holder who wants a target gone", async function () {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 11 }).registry;
  const user = `nm-mood-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 11, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game: agendas seed
  const s = reg.sandboxFor(user).session as unknown as MoodS;
  const [holder, target] = s.live.active.filter((x) => x !== PLAYER) as [EntityId, EntityId];
  const g: Goal = { id: `${holder}:week:get-them-out:${target}:d1`, owner: holder, horizon: "week", kind: "get-them-out", target, why: [{ kind: "threat-read", about: target, weight: 0.9 }],
    test: { kind: "evicted", who: target }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: s.live.week };
  s.live.agendas![holder]!.goals.push(g);
  Object.assign(nm(this), { ms: s, holder, target, moodBefore: s.soulObj(holder)!.emotionalHistory.length });
});
When("the holder's target is evicted", function () {
  const c = nm(this), s = c.ms as MoodS;
  s.live.evictionOrder.push(c.target); s.live.active = s.live.active.filter((x) => x !== c.target);
  s.agendaRecheck("eviction");
});
Then("the holder's mood is lifted and the cause is recorded in their own words", function () {
  const c = nm(this), s = c.ms as MoodS;
  assert.ok(s.soulObj(c.holder)!.emotionalHistory.length > c.moodBefore, "the holder's soul got the event");
  assert.deepEqual({ outcome: s.live.moodCauses![c.holder]!.outcome, line: s.live.moodCauses![c.holder]!.line }, { outcome: "worked", line: "I got {subject} out, like I planned" });
});
Then("the holder tells that cause to a player they trust but not to one they do not", function () {
  const c = nm(this), s = c.ms as MoodS;
  s.rel.edge(c.holder, PLAYER).affinity = 0.1;
  assert.equal(s.npcVoice(c.holder)!.moodCause, undefined, "low trust: the cause is not told");
  s.rel.edge(c.holder, PLAYER).affinity = 0.95;
  const said = s.npcVoice(c.holder)!.moodCause;
  assert.match(said ?? "", /^I got .+ out, like I planned$/);
});

// --- 5. houseguests bring up what others did, only what the house saw ---------------------------------------------------------
type MemS = {
  live: { week: number; npcMemory?: Record<string, Record<string, Array<{ kind: string; week: number; severity: number }>>> };
  presence: Map<EntityId, string>;
  livingIds(): EntityId[];
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  npcVoice(id: EntityId): { rememberedAboutOthers?: string[]; houseguest: { name: string } } | null;
};
Given("a holder who remembers a public thing a houseguest in the room did to them, and a private deal gone wrong", function () {
  const sb = new GameSessionRegistry().sandboxFor(`nm-mem-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
  const s = sb.session as unknown as MemS;
  const [holder, other, third] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  s.setNpcMemoryEnabled(true); s.setNpcMemorySpeechEnabled(true);
  s.live.npcMemory = { [holder]: { [other]: [{ kind: "veto-withheld", week: s.live.week, severity: 0.9 }], [third]: [{ kind: "deal-broken", week: s.live.week, severity: 1 }, { kind: "secret-exposed", week: s.live.week, severity: 1 }] } };
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  for (const id of [holder, other, third, PLAYER]) s.presence.set(id, "kitchen");
  Object.assign(nm(this), { mem: s, holder, other, third });
});
Then("they bring up the public thing with that houseguest's public name", function () {
  const c = nm(this), s = c.mem as MemS;
  const lines = s.npcVoice(c.holder)!.rememberedAboutOthers!;
  const name = s.npcVoice(c.other)!.houseguest.name;
  assert.deepEqual(lines, [`${name} left me on the block when they held the veto (this week)`]);
  assert.ok(!/npc:|\d/.test(JSON.stringify(lines)), "no id, no number");
});
Then("the private deal never reaches the narrator's view of them", function () {
  const c = nm(this), s = c.mem as MemS;
  const lines = JSON.stringify(s.npcVoice(c.holder)!.rememberedAboutOthers ?? []);
  assert.ok(!/broke the deal|told everyone what I trusted/.test(lines), "a private memory is never handed over (Vault Wall)");
});

// --- 6. a juror's style follows their character -------------------------------------------------------------------------------
Given("a played season", function () {
  const { s } = startPlayedSandbox(7);
  nm(this).s = s;
});
Then("every houseguest's juror style comes from their own character and the player has none", function () {
  const s = nm(this).s as GameSessionAdapter;
  const ctx = (s as unknown as { ctx(): { jurorArchetypeFor?: (j: EntityId) => string | undefined } }).ctx();
  const seed = (s as unknown as { gameSeed?: number }).gameSeed ?? 0;
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  assert.ok(npcs.length > 10);
  for (const id of npcs) assert.equal(ctx.jurorArchetypeFor!(id), jurorArchetypeFor(s.agendaCharacterOf(id)!, id, seed));
  assert.equal(ctx.jurorArchetypeFor!(PLAYER), undefined);
  assert.ok(new Set(npcs.map((id) => ctx.jurorArchetypeFor!(id))).size >= 2, "different characters judge differently");
});

// --- 7. the Final HOH reasons from character ----------------------------------------------------------------------------------
type Edge = { from: EntityId; to: EntityId } & EdgeSignals;
const edge = (from: EntityId, to: EntityId, sig: Partial<EdgeSignals>): Edge => ({ from, to, trust: 0.5, affinity: 0.5, threat: 0.3, alignment: 0, confidence: 0.5, reliability: 0.3, ...sig });
async function finalThree(user: string, hohType: { archetype: Archetype; style: StrategyStyle }): Promise<"ally" | "rival" | string> {
  const reg = new GameSessionRegistry();
  const player = reg.resolver()("player", user);
  await player.callTool("createCharacter", { playerName: "Player", seed: 31 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const npcs = (snap as unknown as { house: { npcs: Array<{ id: EntityId; character: { archetype: Archetype; strategyStyle: StrategyStyle } }> } }).house.npcs;
  const [hoh, ally, rival] = [npcs[0]!, npcs[1]!, npcs[2]!];
  hoh.character.archetype = hohType.archetype; hoh.character.strategyStyle = hohType.style;
  const out = [...npcs.slice(3).map((n) => n.id), "player"];
  const jurors = out.slice(out.length - 8);
  snap.live = { week: 13, beat: "final-eviction", active: [hoh.id, ally.id, rival.id], hoh: hoh.id, vetoUsed: false, evictionOrder: out, finished: false } as LiveSeasonState;
  const edges: Edge[] = [edge(hoh.id, ally.id, { trust: 0.85, affinity: 0.9, threat: 0.3 }), edge(hoh.id, rival.id, { trust: 0.2, affinity: 0.15, threat: 0.9 })];
  for (const j of jurors) { edges.push(edge(hoh.id, j, {})); edges.push(edge(ally.id, j, { trust: 0.9, affinity: 0.9 })); edges.push(edge(rival.id, j, { trust: 0.1, affinity: 0.1 })); }
  snap.relationships = edges;
  reg.restore(user, snap);
  await reg.resolver()("player", user).callTool("advanceGame", {});
  const after = reg.snapshot(user) as SessionSnapshot;
  const l = after.live as LiveSeasonState & { ceremony?: { finalEvictee?: EntityId } };
  const evicted = l.ceremony?.finalEvictee ?? l.evictionOrder[l.evictionOrder.length - 1]!;
  return evicted === ally.id ? "ally" : evicted === rival.id ? "rival" : evicted;
}
Given("a Final 3 where the HOH's ally is beloved by the jury and their rival is disliked", function () { /* the crafted Final 3 is built per HOH type below */ });
When("a strategist is the HOH and when a loyalist is the HOH", async function () {
  nm(this).strategist = await finalThree(`nm-fh-a-${Math.random()}`, { archetype: "mastermind", style: "strategic" });
  nm(this).loyalist = await finalThree(`nm-fh-b-${Math.random()}`, { archetype: "loyalist", style: "loyal" });
});
Then("the strategist evicts the beloved ally", function () { assert.equal(nm(this).strategist, "ally"); });
Then("the loyalist evicts the rival", function () { assert.equal(nm(this).loyalist, "rival"); });

// --- 8. pre-show ties behave by their nature ----------------------------------------------------------------------------------
const RIVAL = "npc:2", T_HOUSE = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5", "npc:6", "npc:7", "player"], T_SEED = 4242;
const tChar = (archetype: Archetype, nature: string, friendly: boolean): AgendaCharacter => ({ archetype, strategyStyle: "social", secretKinds: [], preShowTie: { with: RIVAL, hidden: false, friendly, nature } });
const tView = (character: AgendaCharacter, over: Partial<AgendaView> = {}): AgendaView => ({ owner: HOLDER, character, threats: [], affinity: [], grudges: [], emotional: 0.5, allianceMates: [], secretExposed: false, openQuestions: [], answered: [], powerWins: 0, ...over });
const tBoard = (over: Partial<AgendaBoard> = {}): AgendaBoard => ({ day: 2, week: 1, inHouse: T_HOUSE, evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false, ...over });
const tActive = (a: Agenda, kind: string, target?: string): Goal | undefined => a.goals.find((g) => g.kind === kind && (target === undefined || g.target === target));
Given("a houseguest with a pre-show tie", function () { /* each nature is seeded in its own step */ });
Then("a rival is a target from day one", function () {
  const g = tActive(seedAgenda(tView(tChar("analyst", "rival", false)), tBoard(), T_SEED), "get-them-out", RIVAL)!;
  assert.ok(g, "a rival becomes a get-them-out goal");
  assert.equal(g.horizon, "season");
  assert.equal(g.why[0]!.ref, "rival");
});
Then("family is protected hard through any number of quiet nights", function () {
  const v = tView(tChar("floater", "family", true));
  let a = seedAgenda(v, tBoard(), T_SEED);
  assert.ok(tActive(a, "protect-my-person", RIVAL)!.commitment >= 0.9);
  for (let d = 3; d < 15; d++) a = mullAgenda(a, v, tBoard({ day: d }), T_SEED);
  assert.ok(tActive(a, "protect-my-person", RIVAL), "still protecting them after a dozen quiet nights");
  const fam = recheckAgenda(seedAgenda(v, tBoard(), T_SEED), { ...v, threats: [{ toward: RIVAL, threat: 0.95 }] }, tBoard({ day: 4 }), "comp-result", T_SEED);
  assert.ok(tActive(fam, "protect-my-person", RIVAL), "and even a real threat does not end it");
});
Then("an old friend's protection gives way when they become a real threat", function () {
  const v = tView(tChar("analyst", "old-friend", true));
  const a = seedAgenda(v, tBoard(), T_SEED);
  assert.ok(tActive(a, "protect-my-person", RIVAL));
  const pressured = recheckAgenda(a, { ...v, threats: [{ toward: RIVAL, threat: 0.95 }] }, tBoard({ day: 4 }), "comp-result", T_SEED);
  assert.equal(tActive(pressured, "protect-my-person", RIVAL), undefined);
  const ended = pressured.history.find((g) => g.kind === "protect-my-person" && g.target === RIVAL)!;
  assert.equal(ended.status, "replaced");
});
Then("an ex is neither protected nor targeted and is avoided in free time", function () {
  const a = seedAgenda(tView(tChar("analyst", "ex", false)), tBoard(), T_SEED);
  assert.equal(tActive(a, "protect-my-person"), undefined);
  assert.ok(!a.goals.some((g) => g.target === RIVAL && g.horizon === "season"));
  assert.deepEqual(tieAvoids(tChar("analyst", "ex", false)), [RIVAL]);
  assert.deepEqual(tieAvoids(tChar("analyst", "family", true)), []);
});
