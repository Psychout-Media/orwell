import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AllianceStore, AllianceHistoryEntry } from "../../src/engine/alliances";
import type { GroupLife } from "../../src/engine/groupLife";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { Goal } from "../../src/engine/agenda";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** Feature 0172 - groups: roles, nesting, spies, shadow groups, cracking, plus ORW-603 and ORW-611. Drives the REAL adapter. Roles only. */
type Poke = {
  live: { dayNumber?: number; week: number; evictionOrder?: EntityId[]; groupLife?: Record<string, GroupLife>; groupLifeDay?: number; goalApproaches?: Record<string, { desire: string; goalId: string; hour: number }>; agendas?: Record<string, { goals: Goal[] }>; nightDepth?: number };
  alliances: AllianceStore;
  rel: RelationshipModel;
  presence: Map<EntityId, string>;
  ceremony: { hoh?: EntityId };
  groupLifeTick(): void;
  noteAllianceIdentity(id: string, n: string, f: string): void;
  formNpcAlliances(rng: SeededRandom): void;
  houseLifeStretch(events: unknown, ids: readonly EntityId[], i: number): unknown[];
};
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; ids?: EntityId[]; members?: EntityId[]; id?: string; runs?: string[]; shares?: { spy: number; crack: number }; saved?: unknown; loaded?: GameSessionAdapter; spy?: EntityId; to?: EntityId; holder?: EntityId };
const bag = (w: unknown): Bag => ((w as { g0172?: Bag }).g0172 ??= {});
const poke = (s: GameSessionAdapter): Poke => s as unknown as Poke;
let n = 0;

function stage(seed: number, size: number, flag = true): { sb: UserSandbox; s: GameSessionAdapter; p: Poke; ids: EntityId[]; members: EntityId[]; id: string } {
  const sb = new GameSessionRegistry().sandboxFor(`groups0172-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGroupRolesEnabled(flag);
  sb.session.noteMessage({ messageId: "m1" });
  const p = poke(sb.session);
  const ids = sb.session.livingIds().filter((id) => id !== PLAYER);
  const members = ids.slice(0, size);
  for (const a of ids) for (const b of ids) if (a !== b) bond(p, a, b, 0.55);
  for (const a of members) for (const b of members) if (a !== b) bond(p, a, b, 0.8);
  const al = p.alliances.add("Stock Pact", members[0]!, members, 1);
  p.noteAllianceIdentity(al.id, al.name, members[0]!);
  return { sb, s: sb.session, p, ids, members, id: al.id };
}
function bond(p: Poke, a: EntityId, b: EntityId, v: number, threat = 0.1): void { const e = p.rel.edge(a, b); e.trust = v; e.affinity = v; e.threat = threat; }
/** Everyone in the kitchen but the player, who stands in `where`; one in-game day on; the group-life pass runs. */
function day(p: Poke, ids: readonly EntityId[], where = "backyard"): void {
  for (const id of ids) p.presence.set(id, "kitchen");
  p.presence.set(PLAYER, where);
  p.live.groupLifeDay = undefined;
  p.live.dayNumber = (p.live.dayNumber ?? p.live.week) + 1;
  p.groupLifeTick();
}
const history = (p: Poke): readonly AllianceHistoryEntry[] => p.alliances.history();
const kinds = (p: Poke, kind: string): AllianceHistoryEntry[] => history(p).filter((e) => e.kind === kind);

/** A world with an alliance of four, an outsider close to its founder and a third outsider they are close to: the spy's draw. */
function spyWorld(seed: number, where = "backyard", maxDays = 250) {
  const g = stage(seed, 4);
  const [spy, boss] = [g.ids[4]!, g.ids[5]!];
  bond(g.p, spy, g.members[0]!, 0.8); bond(g.p, g.members[0]!, spy, 0.8);
  bond(g.p, spy, boss, 0.95); bond(g.p, boss, spy, 0.95);
  for (let d = 0; d < maxDays && !g.p.live.groupLife?.[g.id]?.spy; d++) day(g.p, g.ids, where);
  return { ...g, spy, boss, drawn: !!g.p.live.groupLife?.[g.id]?.spy };
}
/** The late house: only the four members and the player are left, and two members read a third as the one to cut first. */
function lateWorld(seed: number) {
  const g = stage(seed, 4);
  const [a, b, c, d] = g.members as [EntityId, EntityId, EntityId, EntityId];
  g.p.live.evictionOrder = g.ids.filter((x) => !g.members.includes(x));
  for (const [x, y] of [[a, c], [a, d], [c, d], [d, b]] as const) { bond(g.p, x, y, 0.85); bond(g.p, y, x, 0.85); }
  for (const x of [a, c]) { bond(g.p, x, b, 0.1, 1); bond(g.p, b, x, 0.5); }
  return { ...g, cutters: [a, c], cut: b, left: [b, d] };
}
function crackWorld(seed: number, maxDays = 120) {
  const g = lateWorld(seed);
  for (let d = 0; d < maxDays && g.p.live.groupLife?.[g.id]?.crackedDay === undefined; d++) day(g.p, g.ids);
  return g;
}

Given("groups: a season where a named alliance of five houseguests has been together a few weeks", function () {
  const g = stage(7, 5); day(g.p, g.ids); Object.assign(bag(this), { s: g.s, sb: g.sb, members: g.members, id: g.id });
});
Then("groups: each member holds a role and no role is held by two members", function () {
  const b = bag(this); const roles = poke(b.s!).live.groupLife![b.id!]!.roles;
  assert.deepEqual(Object.keys(roles).sort(), [...b.members!].sort());
  assert.equal(new Set(Object.values(roles)).size, 5);
});

Given("groups: a season where an outsider is drawn to an alliance only to learn its plans", function () {
  let w = spyWorld(7);
  for (let seed = 8; !w.drawn && seed < 20; seed++) w = spyWorld(seed);
  assert.ok(w.drawn, "no seed drew a spy");
  Object.assign(bag(this), { s: w.s, sb: w.sb, id: w.id, spy: w.spy, to: w.boss, members: w.members });
});
Then("groups: the spy tells the person they really work for, in a scene only the two of them are in", function () {
  const b = bag(this); const spy = poke(b.s!).live.groupLife![b.id!]!.spy!;
  const scene = b.sb!.engine.events.queryAll().filter((e) => e.type === "spy-report");
  assert.ok(scene.length >= 1);
  assert.deepEqual([...scene[0]!.witnessSet].sort(), [spy.member, spy.reportsTo].sort());
  assert.equal(scene[0]!.hidden, true);
});
Then("groups: the alliance history keeps the spy and the report", function () {
  const p = poke(bag(this).s!);
  assert.equal(kinds(p, "spy-planted").length, 1);
  assert.ok(kinds(p, "spy-report").length >= 1);
  assert.ok(kinds(p, "joined").some((e) => e.who === p.live.groupLife![bag(this).id!]!.spy!.member));
});

Given("groups: a season where three of an alliance's members are closer to each other than to the rest", function () {
  const g = stage(7, 5);
  const [t1, t2, t3, o1, o2] = g.members as [EntityId, EntityId, EntityId, EntityId, EntityId];
  for (const x of [t1, t2, t3]) for (const y of [t1, t2, t3]) if (x !== y) bond(g.p, x, y, 0.95);
  for (const x of [t1, t2, t3]) for (const y of [o1, o2]) { bond(g.p, x, y, 0.5); bond(g.p, y, x, 0.5); }
  bond(g.p, o1, o2, 0.5); bond(g.p, o2, o1, 0.5);
  day(g.p, g.ids); Object.assign(bag(this), { s: g.s, id: g.id, members: [t1, t2, t3] });
});
Then("groups: the three hold a nested inner group the others do not know of", function () {
  const b = bag(this); const p = poke(b.s!);
  assert.deepEqual([...p.live.groupLife![b.id!]!.inner!].sort(), [...b.members!].sort());
  assert.equal(p.alliances.all().length, 1); // nested, not a second alliance in the list
  assert.equal(kinds(p, "inner-circle").length, 1);
});

Given("groups: a season where an alliance reaches the late house with two members aiming their first cut at a third", function () {
  const g = crackWorld(7); Object.assign(bag(this), { s: g.s, id: g.id, members: g.members, to: g.cut, ids: g.cutters });
  assert.ok(g.p.live.groupLife![g.id]!.crackedDay !== undefined, "the alliance never cracked");
});
Then("groups: the alliance cracks, and the two who aimed at their own found a new one", function () {
  const b = bag(this); const p = poke(b.s!);
  const born = p.alliances.all().find((a) => a.id !== b.id)!;
  assert.deepEqual([...born.members].sort(), [...b.ids!].sort());
  assert.ok(!p.alliances.byId(b.id!)!.members.some((m) => b.ids!.includes(m)));
  assert.equal(kinds(p, "cracked").length, 1);
});

Given("groups: a season where an alliance holds the crown and means to cut an outsider", function () {
  const g = stage(7, 3);
  const [x, y, z] = [g.ids[3]!, g.ids[4]!, g.ids[5]!];
  g.p.live.evictionOrder = g.ids.slice(6);
  g.p.ceremony.hoh = g.members[0]!;
  for (const m of g.members) bond(g.p, m, x, 0.2, 0.9);
  for (const [a, c] of [[x, y], [x, z], [y, z]] as const) { bond(g.p, a, c, 0.85); bond(g.p, c, a, 0.85); }
  for (let d = 0; d < 120 && g.p.alliances.all().length < 2; d++) day(g.p, g.ids);
  Object.assign(bag(this), { s: g.s, id: g.id, members: g.members, ids: [x, y, z] });
});
Then("groups: the outsiders form a counter-alliance the first group is not part of", function () {
  const b = bag(this); const p = poke(b.s!);
  const shadow = p.alliances.all().find((a) => a.id !== b.id);
  assert.ok(shadow, "no counter-alliance formed");
  assert.ok(shadow.members.every((m) => b.ids!.includes(m)) && shadow.members.length >= 2);
  assert.ok(shadow.knownTo.every((k) => !b.members!.includes(k)));
  assert.equal(p.live.groupLife![shadow.id]!.shadowOf, b.id);
  assert.equal(kinds(p, "shadow-formed").length, 1);
});

Given("groups: a season where an alliance holds a spy, an inner circle and a private cut order", function () {
  let w = spyWorld(7);
  for (let seed = 8; !w.drawn && seed < 20; seed++) w = spyWorld(seed);
  assert.ok(w.drawn);
  Object.assign(bag(this), { s: w.s, sb: w.sb, id: w.id });
});
Then("groups: no player or admin view shows any of them", async function () {
  const b = bag(this); const life = poke(b.s!).live.groupLife![b.id!]!;
  assert.ok(life.spy && Object.keys(life.roles).length > 0 && life.cutOrder);
  const surfaces = [
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}), await b.sb!.mcp.player.callTool("getMomentPrompt", {}),
    await b.sb!.mcp.player.callTool("seasonRecap", {}), await b.sb!.mcp.player.callTool("whereabouts", {}), await b.sb!.mcp.player.callTool("seasonRetrospective", {}),
    await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ];
  const blob = JSON.stringify(surfaces);
  for (const k of ["groupLife", "cutOrder", "spy-planted", "spy-report", "shadow-formed", "inner-circle", "comp-threat", "reportsTo", "toldRoster", "crackedDay", "allianceHistory"]) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
});

Given("groups: a season where the spy and the one they work for meet while the player is in the room", function () {
  let w = spyWorld(7, "kitchen");
  for (let seed = 8; !w.drawn && seed < 20; seed++) w = spyWorld(seed, "kitchen");
  assert.ok(w.drawn);
  let other = spyWorld(7, "backyard");
  for (let seed = 8; !other.drawn && seed < 20; seed++) other = spyWorld(seed, "backyard");
  Object.assign(bag(this), { sb: w.sb, s: w.s, id: w.id, saved: other.sb, loaded: other.s });
});
Then("groups: the player witnessed that scene", function () {
  const scene = bag(this).sb!.engine.events.queryAll().filter((e) => e.type === "spy-report");
  assert.ok(scene.length >= 1 && scene[0]!.witnessSet.includes(PLAYER) && scene[0]!.hidden === false);
});
Then("groups: with the player in another room the player did not witness it", function () {
  const scene = (bag(this).saved as UserSandbox).engine.events.queryAll().filter((e) => e.type === "spy-report");
  assert.ok(scene.length >= 1 && !scene[0]!.witnessSet.includes(PLAYER) && scene[0]!.hidden === true);
});

function play(seed: number): { life: string; hist: string; spy: boolean; cracked: boolean } {
  const w = spyWorld(seed, "backyard", 40);
  const late = crackWorld(seed, 1); // one night: the daily chance, not the certainty of a long wait
  return { life: JSON.stringify([w.p.live.groupLife, late.p.live.groupLife]), hist: JSON.stringify([history(w.p), history(late.p)]), spy: w.drawn, cracked: late.p.live.groupLife![late.id]?.crackedDay !== undefined };
}
Given("groups: a season played twice from the same seed", function () { bag(this).runs = [JSON.stringify(play(11)), JSON.stringify(play(11))]; });
Then("groups: both runs hold the same roles, spies and splits in the same order", function () { assert.equal(bag(this).runs![0], bag(this).runs![1]); });
Then("groups: across many seeds the share of cracked alliances and of spies sits inside the reported mix band", function () {
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  const rows = seeds.map(play);
  const spy = rows.filter((r) => r.spy).length / seeds.length, crack = rows.filter((r) => r.cracked).length / seeds.length;
  // The band is what the daily chances are tuned to: not every group is spied on, not every group cracks (and some do, so the dial is live).
  assert.ok(spy > 0 && spy < 0.9, `spy share ${spy}`);
  assert.ok(crack > 0 && crack < 0.8, `crack share ${crack}`);
});

Given("groups: a season where an alliance cracked into two", function () { const g = crackWorld(7); Object.assign(bag(this), { s: g.s, id: g.id }); });
When("groups: the season is saved and loaded into a fresh session", function () {
  const b = bag(this);
  b.saved = JSON.parse(JSON.stringify(b.s!.snapshot()));
  const fresh = new GameSessionRegistry().sandboxFor(`groups0172-${n++}`).session;
  fresh.restore(b.saved as Parameters<GameSessionAdapter["restore"]>[0]);
  b.loaded = fresh;
});
Then("groups: the loaded session holds the roles, the nesting and the split the saved one held", function () {
  const b = bag(this);
  assert.deepEqual(poke(b.loaded!).live.groupLife, poke(b.s!).live.groupLife);
  assert.ok(Object.values(poke(b.loaded!).live.groupLife!).some((l) => l.crackedDay !== undefined));
  assert.deepEqual(poke(b.loaded!).alliances.serialize(), poke(b.s!).alliances.serialize());
});
Then("groups: the alliance history still holds the original alliance and the new ones", function () {
  const b = bag(this); const h = history(poke(b.loaded!));
  assert.deepEqual(h, history(poke(b.s!)));
  const formed = h.filter((e) => e.kind === "formed").map((e) => e.allianceId);
  assert.ok(formed.includes(b.id!) && new Set(formed).size >= 2);
  assert.ok(h.some((e) => e.kind === "cracked" && e.allianceId === b.id));
});

Given("groups: a season with the kill switch thrown where an alliance of five has been together a few weeks", function () {
  const g = stage(7, 5, false); for (let d = 0; d < 10; d++) day(g.p, g.ids); Object.assign(bag(this), { s: g.s });
});
Then("groups: the season holds no group life and no history entry of one", function () {
  const p = poke(bag(this).s!);
  assert.equal(p.live.groupLife, undefined); assert.equal(p.live.groupLifeDay, undefined);
  assert.deepEqual(history(p).map((e) => e.kind), ["formed"]);
});

Given("groups: a season where an alliance pitched the player with a roster, and then took in another houseguest", function () {
  const g = stage(7, 3);
  g.p.alliances.reveal(g.id, PLAYER, g.members);
  g.p.alliances.join(g.id, g.ids[5]!);
  Object.assign(bag(this), { s: g.s, members: g.members, id: g.id });
});
Then("groups: the pitch the player sees still shows the roster they were told", function () {
  const b = bag(this); const pitch = b.s!.gameStatus().alliancePitches!.find((a) => a.id === b.id)!;
  assert.deepEqual(pitch.members.map((m) => m.id).sort(), [...b.members!].sort());
  assert.ok(poke(b.s!).alliances.byId(b.id!)!.members.length === 4); // the live roster moved on
});

function hostileGoal(holder: EntityId, s: Poke): Goal {
  return { id: `${holder}:week:get-them-out:d1`, owner: holder, horizon: "week", kind: "get-them-out", target: PLAYER, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week } as unknown as Goal;
}
Given("groups: a season where a houseguest the player does not trust has a goal to get the player out", function () {
  for (let seed = 11; seed < 30; seed++) {
    const g = stage(seed, 2);
    const p = g.p; const holder = g.ids[0]!;
    p.live.agendas![holder]!.goals.push(hostileGoal(holder, p));
    for (const id of [...p.presence.keys()]) p.presence.set(id, "backyard");
    p.presence.set(PLAYER, "kitchen");
    bond(p, holder, PLAYER, 0.1, 0.9);
    const awake = [...g.ids.slice(0, 4), PLAYER] as EntityId[];
    for (let i = 0; i < 14 && !p.live.goalApproaches?.[holder]; i++) { p.live.nightDepth = (p.live.nightDepth ?? 8) + 1; p.houseLifeStretch(g.sb.engine.events, awake, i); }
    if (p.live.goalApproaches?.[holder]) { Object.assign(bag(this), { s: g.s, holder }); return; }
  }
  assert.fail("no seed raised the approach");
});
Then("groups: that houseguest comes to the player through the desire clock's own approach", function () {
  const b = bag(this); assert.equal(poke(b.s!).live.goalApproaches![b.holder!]!.desire, "probe");
});

Given("groups: a season where a houseguest with an alliance has a goal to pull the player in", function () {
  const g = stage(7, 3);
  g.p.live.evictionOrder = g.ids.slice(5);
  const holder = g.members[1]!;
  g.p.live.agendas![holder]!.goals.push({ ...hostileGoal(holder, g.p), kind: "pull-them-in", id: `${holder}:week:pull:d1` } as unknown as Goal);
  bond(g.p, holder, PLAYER, 0.8); bond(g.p, PLAYER, holder, 0.8);
  for (let i = 0; i < 6 && g.p.alliances.pitchesFor(PLAYER).length === 0; i++) g.p.formNpcAlliances(new SeededRandom(i + 1));
  Object.assign(bag(this), { s: g.s, id: g.id, members: g.members, holder });
});
Then("groups: the player is pitched that alliance and shown only its roster as told", function () {
  const b = bag(this); const pitch = b.s!.gameStatus().alliancePitches?.find((a) => a.id === b.id);
  assert.ok(pitch, "the player was not pitched");
  assert.deepEqual(pitch.members.map((m) => m.id).sort(), [...b.members!].sort());
});

Given("groups: a season where an alliance has settled on the player as its target and pitched them earlier", function () {
  const g = stage(7, 3);
  for (const m of g.members) { bond(g.p, m, PLAYER, 0.1, 1); bond(g.p, PLAYER, m, 0.1); }
  g.p.alliances.reveal(g.id, PLAYER, g.members);
  day(g.p, g.ids);
  Object.assign(bag(this), { s: g.s, sb: g.sb, id: g.id, members: g.members });
});
Then("groups: one member comes to the player through the desire clock's own approach", function () {
  const b = bag(this); const a = poke(b.s!).live.goalApproaches ?? {};
  assert.ok(Object.entries(a).some(([k, v]) => b.members!.includes(k) && v.desire === "probe" && v.goalId.startsWith("group:")));
});
Then("groups: the pitch is withdrawn in an event the player was in, with no roster shown", function () {
  const b = bag(this); const p = poke(b.s!);
  const ev = b.sb!.engine.events.queryAll().filter((e) => e.type === "alliance-pitch-withdrawn");
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.witnessSet.includes(PLAYER) && ev[0]!.hidden === false);
  for (const m of b.members!.slice(1)) assert.ok(!ev[0]!.content.includes((b.s as unknown as { nameOf(id: string): string }).nameOf(m)));
  assert.equal(b.s!.gameStatus().alliancePitches, undefined);
  assert.equal(kinds(p, "pitch-withdrawn").length, 1);
});
