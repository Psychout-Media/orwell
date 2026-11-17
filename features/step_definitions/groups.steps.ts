import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AllianceStore, AllianceHistoryEntry } from "../../src/engine/alliances";
import type { GroupLife } from "../../src/engine/groupLife";
import type { SpokenClaim } from "../../src/engine/spokenClaims";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { Goal } from "../../src/engine/agenda";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** Feature 0172 - groups: roles, nesting, spies, shadow groups, cracking, plus ORW-603 and ORW-611. Drives the REAL adapter. Roles only. */
type Poke = {
  live: { dayNumber?: number; week: number; evictionOrder?: EntityId[]; groupLife?: Record<string, GroupLife>; claims?: { items: SpokenClaim[] }; groupLifeDay?: number; goalApproaches?: Record<string, { desire: string; goalId: string; hour: number }>; agendas?: Record<string, { goals: Goal[] }>; nightDepth?: number };
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
function day(p: Poke, ids: readonly EntityId[], where = "backyard", at: Readonly<Record<string, string>> = {}): void {
  for (const id of ids) p.presence.set(id, at[id] ?? "kitchen");
  p.presence.set(PLAYER, where);
  p.live.groupLifeDay = undefined;
  p.live.dayNumber = (p.live.dayNumber ?? p.live.week) + 1;
  p.groupLifeTick();
}
const history = (p: Poke): readonly AllianceHistoryEntry[] => p.alliances.history();
const kinds = (p: Poke, kind: string): AllianceHistoryEntry[] => history(p).filter((e) => e.kind === kind);

/** A world with an alliance of four, an outsider close to its founder and a third outsider they are close to: the spy's draw. */
function spyWorld(seed: number, where = "backyard", maxDays = 250, opts: { bossAt?: string; asleep?: boolean; target?: "player" } = {}) {
  const g = stage(seed, 4);
  const [spy, boss] = [g.ids[4]!, g.ids[5]!];
  bond(g.p, spy, g.members[0]!, 0.8); bond(g.p, g.members[0]!, spy, 0.8);
  bond(g.p, spy, boss, 0.95); bond(g.p, boss, spy, 0.95);
  for (const o of g.ids.slice(5)) { bond(g.p, o, g.members[0]!, 0.3); bond(g.p, g.members[0]!, o, 0.3); } // only the first outsider is close enough to the founder to be drawn: the spy and the boss are who the scenario says
  if (opts.asleep) (g.p as unknown as { awakeNow(): Set<EntityId> }).awakeNow = () => new Set(g.ids);
  if (opts.target === "player") for (const m of g.members) { bond(g.p, m, PLAYER, 0.1, m === g.members[0]! ? 1 : 1); bond(g.p, PLAYER, m, 0.1); }
  const at = opts.bossAt ? { [boss]: opts.bossAt } : {};
  for (let d = 0; d < maxDays && !g.p.live.groupLife?.[g.id]?.spy; d++) day(g.p, g.ids, where, at);
  return { ...g, spy, boss, at, drawn: !!g.p.live.groupLife?.[g.id]?.spy };
}
const drawn = <T extends { drawn: boolean }>(make: (seed: number) => T): T => { for (let seed = 7; seed < 40; seed++) { const w = make(seed); if (w.drawn) return w; } throw new Error("no seed drew a spy"); };
type X = { w?: ReturnType<typeof spyWorld>; other?: ReturnType<typeof spyWorld>; g?: ReturnType<typeof stage>; n?: number; before?: number; thr?: number; npc?: EntityId[]; target?: EntityId; teller?: EntityId; claims?: SpokenClaim[] };
const xb = (w: unknown): X => ((w as { x0172?: X }).x0172 ??= {});
const claimsOf = (p: Poke, speaker: EntityId, listener: EntityId): SpokenClaim[] => (p.live.claims?.items ?? []).filter((c) => c.speaker === speaker && c.listener === listener);
/** The warmth that turns a spy: loyal to the group, cool to the one they work for. */
function warm(p: Poke, spy: EntityId, members: readonly EntityId[], boss: EntityId, toGroup: number, toBoss: number): void {
  for (const m of members) if (m !== spy) bond(p, spy, m, toGroup);
  bond(p, spy, boss, toBoss);
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
  for (const m of g.members) { bond(g.p, m, x, 0.2, 0.9); bond(g.p, x, m, 0.5, 0.8); } // the crown holders mean to cut x, and x reads them as a threat
  for (const [a, c] of [[x, y], [x, z], [y, z]] as const) { bond(g.p, a, c, 0.85); bond(g.p, c, a, 0.85); }
  for (const o of [y, z]) for (const m of g.members) bond(g.p, o, m, 0.5, 0.6);
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
const WALLED = ["groupLife", "cutOrder", "spy-planted", "spy-report", "spy-turned", "spy-confessed", "shadow-formed", "inner-circle", "comp-threat", "reportsTo", "toldRoster", "crackedDay", "allianceHistory", "evictWon", "bumped"];
async function surfaceBlob(sb: UserSandbox): Promise<string> {
  return JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.player.callTool("seasonRetrospective", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
}
Then("groups: no player or admin view shows any of them", async function () {
  const b = bag(this); const life = poke(b.s!).live.groupLife![b.id!]!;
  assert.ok(life.spy && Object.keys(life.roles).length > 0 && life.cutOrder);
  const surfaces = [
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}), await b.sb!.mcp.player.callTool("getMomentPrompt", {}),
    await b.sb!.mcp.player.callTool("seasonRecap", {}), await b.sb!.mcp.player.callTool("whereabouts", {}), await b.sb!.mcp.player.callTool("seasonRetrospective", {}),
    await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ];
  const blob = JSON.stringify(surfaces);
  for (const k of WALLED) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
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

// ---- the follow-up: a spy who turns, the broader shadow trigger, the told claims, the player's own alliance ----
const turnedWorld = (seed: number) => {
  const w = spyWorld(seed);
  if (!w.drawn) return { ...w, turned: undefined as NonNullable<GroupLife["spy"]>["turned"] };
  warm(w.p, w.spy, w.members, w.boss, 0.95, 0.4);
  for (let d = 0; d < 300 && w.p.live.groupLife![w.id]!.spy!.turned === undefined; d++) day(w.p, w.ids);
  return { ...w, turned: w.p.live.groupLife![w.id]!.spy!.turned };
};
Given("groups: a season where a spy is warmer toward the alliance than toward the person they work for", function () {
  let w = turnedWorld(7);
  for (let seed = 8; !w.turned && seed < 40; seed++) w = turnedWorld(seed);
  assert.ok(w.turned, "no spy turned");
  xb(this).w = w as unknown as ReturnType<typeof spyWorld>;
});
Then("groups: the spy turns, the history keeps it, and a spy who has turned never reports the real plan to the one they worked for again", function () {
  const w = xb(this).w!; const p = w.p; const turned = p.live.groupLife![w.id]!.spy!.turned!;
  assert.ok(kinds(p, "spy-turned").some((e) => e.who === w.spy));
  assert.equal(kinds(p, "spy-confessed").length, turned === "confessed" ? 1 : 0);
  const reports = kinds(p, "spy-report").length, told = claimsOf(p, w.spy, w.boss).length;
  for (let d = 0; d < 12; d++) { p.live.groupLife![w.id]!.agreed = undefined; day(p, w.ids); } // the plan settles again each day
  if (turned === "double-cross") assert.ok(claimsOf(p, w.spy, w.boss).slice(told).every((c) => !c.isTrue && c.intent === "mislead"));
  else { assert.equal(kinds(p, "spy-report").length, reports); assert.equal(claimsOf(p, w.spy, w.boss).length, told); }
});

Given("groups: a season where a spy is closer to the person they work for than to anyone in the alliance", function () {
  const w = drawn((seed) => spyWorld(seed));
  warm(w.p, w.spy, w.members, w.boss, 0.5, 0.95);
  for (let d = 0; d < 80; d++) day(w.p, w.ids);
  xb(this).w = w;
});
Then("groups: the spy never turns", function () { const w = xb(this).w!; assert.equal(w.p.live.groupLife![w.id]!.spy!.turned, undefined); assert.equal(kinds(w.p, "spy-turned").length, 0); });

Given("groups: a season where a spy has turned and feeds the person they work for a wrong target", function () {
  const w = drawn((seed) => spyWorld(seed));
  const spy = w.p.live.groupLife![w.id]!.spy!; spy.turned = "double-cross"; spy.reported = undefined;
  xb(this).w = w; xb(this).n = claimsOf(w.p, w.spy, w.boss).length;
  day(w.p, w.ids);
});
Then("groups: the one they report to is told one claim naming a target the alliance did not agree, and the engine holds it as a lie", function () {
  const x = xb(this); const w = x.w!; const life = w.p.live.groupLife![w.id]!;
  const fresh = claimsOf(w.p, w.spy, w.boss).slice(x.n!);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.isTrue, false); assert.equal(fresh[0]!.intent, "mislead");
  assert.equal(fresh[0]!.kind, "going-after"); assert.notEqual(fresh[0]!.object, life.agreed);
});

Then("groups: the report is one claim about the member who drives the plan, true, meant to inform", function () {
  const b = bag(this); const p = poke(b.s!); const life = p.live.groupLife![b.id!]!;
  const claims = claimsOf(p, b.spy!, b.to!);
  assert.equal(claims.length, kinds(p, "spy-report").length); // ONE per report, not one per member
  const c = claims[0]!;
  assert.ok(b.members!.includes(c.subject) && c.subject !== b.spy);
  assert.equal(c.isTrue, true); assert.equal(c.intent, "inform");
  assert.ok(c.kind === "going-after" ? c.object === life.agreed : c.kind === "targets-you" && life.agreed === b.to);
});

function warnWorld(seed: number, where: string) {
  const w = spyWorld(seed, where, 250, { target: "player" });
  if (!w.drawn) return { ...w, turned: undefined as string | undefined };
  const spy = w.spy; bond(w.p, spy, PLAYER, 0.1, 0); // the spy is not the one who presses the player: only a real talk reaches them
  warm(w.p, spy, w.members, w.boss, 0.95, 0.4);
  for (let d = 0; d < 300 && w.p.live.groupLife![w.id]!.spy!.turned === undefined; d++) day(w.p, w.ids, where);
  return { ...w, turned: w.p.live.groupLife![w.id]!.spy!.turned as string | undefined };
}
Given("groups: a season where a spy who works for another turns while the alliance has settled on the player, in the player's room", function () {
  for (let seed = 7; seed < 60; seed++) {
    const a = warnWorld(seed, "kitchen");
    if (a.turned !== "quiet" && a.turned !== "confessed") continue;
    if (a.p.live.groupLife![a.id]!.agreed !== PLAYER) continue;
    const b = warnWorld(seed, "backyard");
    xb(this).w = a as unknown as ReturnType<typeof spyWorld>; xb(this).other = b as unknown as ReturnType<typeof spyWorld>; return;
  }
  assert.fail("no seed turned a spy toward the player");
});
Then("groups: the player heard one claim from the spy", function () {
  const x = xb(this); const heard = x.w!.s.claimsThePlayerHeard();
  assert.equal(heard.length, 1); assert.equal(heard[0]!.speaker, x.w!.spy); assert.equal(heard[0]!.kind, "targets-you");
  assert.ok(!("isTrue" in heard[0]!) && !("intent" in heard[0]!));
});
Then("groups: the same season with the player in another room leaves the player no claim", function () {
  assert.equal(xb(this).other!.s.claimsThePlayerHeard().length, 0);
});

const reportScenes = (w: { sb: UserSandbox }) => w.sb.engine.events.queryAll().filter((e) => e.type === "spy-report");
Given("groups: a season where the spy is in the player's room but the one they report to is not", function () {
  xb(this).w = drawn((seed) => spyWorld(seed, "kitchen", 250, { bossAt: "backyard" }));
});
Then("groups: the player did not witness the report", function () {
  const sc = reportScenes(xb(this).w!); assert.ok(sc.length >= 1);
  assert.ok(sc.every((e) => !e.witnessSet.includes(PLAYER) && e.hidden === true));
});
Then("groups: with the player asleep in the same room as both, the player did not witness it either", function () {
  const sc = reportScenes(drawn((seed) => spyWorld(seed, "kitchen", 250, { asleep: true }))); assert.ok(sc.length >= 1);
  assert.ok(sc.every((e) => !e.witnessSet.includes(PLAYER) && e.hidden === true));
});

/** The outsiders read the alliance's members as a threat and are warm with each other; the members read them as the ones to cut. */
function threatened(g: ReturnType<typeof stage>, outsiders: readonly EntityId[]): void {
  for (const o of outsiders) for (const m of g.members) { bond(g.p, o, m, 0.5, 0.8); bond(g.p, m, o, 0.3, 0.9); }
  for (const a of outsiders) for (const c of outsiders) if (a !== c) bond(g.p, a, c, 0.85, 0.1);
}
const shadows = (p: Poke): AllianceHistoryEntry[] => kinds(p, "shadow-formed");
function untilShadow(g: ReturnType<typeof stage>, days = 150): void { for (let d = 0; d < days && shadows(g.p).length === 0; d++) day(g.p, g.ids); }
Given("groups: a season where an alliance is most of the houseguests left and the others read its members as a threat", function () {
  const g = stage(7, 5); g.p.live.evictionOrder = g.ids.slice(8); threatened(g, g.ids.slice(5, 8)); untilShadow(g); xb(this).g = g;
});
Then("groups: the threatened outsiders form a counter-alliance", function () {
  const g = xb(this).g!; const sh = shadows(g.p);
  assert.equal(sh.length, 1);
  const born = g.p.alliances.all().find((a) => a.id !== g.id)!;
  assert.ok(born.members.length >= 2 && born.members.every((m) => !g.members.includes(m)));
  assert.equal(g.p.live.groupLife![born.id]!.shadowOf, g.id);
});
Given("groups: a season where an alliance has carried the last two evictions without the crown and the others read its members as a threat", function () {
  const g = stage(7, 3); g.p.live.evictionOrder = g.ids.slice(8); threatened(g, g.ids.slice(3, 8));
  day(g.p, g.ids);
  for (let i = 0; i < 2; i++) { const t = g.p.live.groupLife![g.id]!.agreed!; g.p.live.evictionOrder = [...g.p.live.evictionOrder!, t]; day(g.p, g.ids); }
  assert.deepEqual(g.p.live.groupLife![g.id]!.evictWon, [true, true]);
  untilShadow(g); xb(this).g = g;
});
Given("groups: a season where a small alliance holds neither the crown, a majority, nor a streak and the others read its members as a threat", function () {
  const g = stage(7, 3); g.p.live.evictionOrder = g.ids.slice(8); threatened(g, g.ids.slice(3, 8)); untilShadow(g, 150); xb(this).g = g;
});
Then("groups: no counter-alliance forms", function () { const g = xb(this).g!; assert.equal(shadows(g.p).length, 0); assert.equal(g.p.alliances.all().length, 1); });

Given("groups: a season where an alliance's agreed target flips away and back", function () {
  const g = stage(7, 4); xb(this).g = g;
  g.p.live.evictionOrder = g.ids.slice(7); for (const m of g.members) for (const o of g.ids.slice(4, 7)) bond(g.p, m, o, 0.3, 0.5);
  day(g.p, g.ids);
  const life = g.p.live.groupLife![g.id]!; const A = life.agreed!;
  xb(this).target = A; xb(this).thr = g.p.rel.peek(g.members[0]!, A).threat;
  assert.deepEqual(life.bumped, [A]);
  life.agreed = g.members[0]!; // the plan moved off it for a moment (the next draw-up names it again)
  day(g.p, g.ids);
});
Then("groups: each member's read of that target moved one step only", function () {
  const x = xb(this); const g = x.g!; const life = g.p.live.groupLife![g.id]!;
  assert.equal(life.agreed, x.target);
  assert.deepEqual(life.bumped, [x.target]);
  for (const m of g.members) assert.ok(Math.abs(g.p.rel.peek(m, x.target!).threat - x.thr!) < 1e-9, "a second step was taken");
});

Given("groups: a season where two members of an alliance break away while the alliance means to take out an outsider they like", function () {
  const mk = (seed: number, playerAt: string) => {
    const g = stage(seed, 4); const [a, b, c, d] = g.members as [EntityId, EntityId, EntityId, EntityId]; const o = g.ids[4]!;
    g.p.live.evictionOrder = g.ids.slice(5);
    for (const [x, y] of [[a, c], [a, d], [c, d], [d, b]] as const) { bond(g.p, x, y, 0.85); bond(g.p, y, x, 0.85); }
    for (const x of [a, c]) { bond(g.p, x, b, 0.1, 1); bond(g.p, b, x, 0.5); }
    for (const m of g.members) bond(g.p, m, o, 0.3, 1);
    for (const x of [a, c]) { bond(g.p, x, o, 0.45, 0.5); bond(g.p, o, x, 0.45); } // the two who will break away like the outsider and read b as the bigger threat
    return { g, o, playerAt };
  };
  const w = mk(7, "kitchen");
  for (let d = 0; d < 200 && w.g.p.live.groupLife?.[w.g.id]?.crackedDay === undefined; d++) day(w.g.p, w.g.ids, "backyard");
  assert.ok(w.g.p.live.groupLife![w.g.id]!.crackedDay !== undefined, "the alliance never cracked");
  xb(this).g = w.g; xb(this).target = w.o; xb(this).teller = w.g.p.alliances.all().find((a) => a.id !== w.g.id)!.founder;
});
Then("groups: that outsider is told one claim about the member who drives the plan", function () {
  const x = xb(this); const p = x.g!.p; const life = p.live.groupLife![x.g!.id]!;
  assert.equal(life.agreed, x.target);
  const told = (p.live.claims?.items ?? []).filter((c) => c.listener === x.target);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.kind, "targets-you"); assert.equal(told[0]!.isTrue, true); assert.equal(told[0]!.intent, "inform");
  assert.ok(x.g!.members.includes(told[0]!.subject) && told[0]!.subject !== told[0]!.speaker);
});
Then("groups: with the player as the target and in the breakaway's room, the player is told it too, and in another room is not", function () {
  const run = (playerHere: boolean): number => {
    for (let seed = 7; seed < 50; seed++) {
      const g = stage(seed, 4); const [a, b, c, d] = g.members as [EntityId, EntityId, EntityId, EntityId];
      g.p.live.evictionOrder = g.ids.slice(4); // only the four and the player are left
      for (const [x, y] of [[a, c], [a, d], [c, d], [d, b]] as const) { bond(g.p, x, y, 0.85); bond(g.p, y, x, 0.85); }
      for (const x of [a, c]) { bond(g.p, x, b, 0.1, 1); bond(g.p, b, x, 0.5); }
      for (const m of g.members) bond(g.p, m, PLAYER, 0.1, m === a || m === c ? 0.6 : 1); // b and d are the ones who press the player (the approach path), not the two who break away
      const life = (): GroupLife | undefined => g.p.live.groupLife?.[g.id];
      for (let k = 0; k < 200 && life()?.crackedDay === undefined; k++) { day(g.p, g.ids, playerHere ? "kitchen" : "backyard"); }
      if (life()?.crackedDay === undefined || life()!.agreed !== PLAYER) continue;
      return g.s.claimsThePlayerHeard().filter((h) => h.kind === "targets-you").length;
    }
    throw new Error("no seed cracked toward the player");
  };
  assert.equal(run(true), 1); assert.equal(run(false), 0);
});

Given("groups: a season where the player belongs to an alliance with three houseguests", function () {
  const g = stage(7, 3); const mine = [PLAYER, g.ids[5]!, g.ids[6]!, g.ids[7]!];
  const al = g.p.alliances.add("Player Pact", PLAYER, mine, 1);
  for (let d = 0; d < 20; d++) day(g.p, g.ids);
  Object.assign(xb(this), { g, npc: mine.slice(1), target: al.id });
});
Then("groups: the three hold roles in the history, the player holds none, the alliance is unchanged, and no view shows them", async function () {
  const x = xb(this); const g = x.g!; const id = x.target!;
  const life = g.p.live.groupLife![id]!;
  assert.deepEqual(Object.keys(life.roles).sort(), [...x.npc!].sort());
  assert.ok(!(PLAYER in life.roles));
  const roles = history(g.p).filter((e) => e.kind === "roles" && e.allianceId === id);
  assert.ok(roles.length >= 1 && roles.every((e) => !(e.detail ?? "").includes(PLAYER)));
  assert.deepEqual([...g.p.alliances.byId(id)!.members].sort(), [PLAYER, ...x.npc!].sort());
  assert.ok(Object.keys(life.cutOrder ?? {}).sort().join() === [...x.npc!].sort().join()); // the NPC members hold cut orders; none of them names the player (no member's goal is their exit)
  assert.ok(!Object.values(life.cutOrder!).flat().includes(PLAYER)); assert.notEqual(life.agreed, PLAYER);
  const blob = await surfaceBlob(g.sb);
  for (const k of WALLED) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
});

// ---- ORW-616: the player's alliances fade and break like any other ----
type Fader = { fadeAlliances(): void };
function playerPact(seed: number, members = 3) {
  const g = stage(seed, 3);
  const npcs = g.ids.slice(5, 5 + members);
  const al = g.p.alliances.add("Player Pact", PLAYER, [PLAYER, ...npcs], 1);
  return { ...g, npcs, pact: al.id, pactName: al.name };
}
const eventsOf = (sb: UserSandbox, type: string) => sb.engine.events.queryAll().filter((e) => e.type === type);
Given("groups: a season where the player belongs to an alliance whose bonds with the player have gone cold", function () {
  const g = playerPact(7);
  for (const m of g.npcs) { bond(g.p, PLAYER, m, 0.1); bond(g.p, m, PLAYER, 0.1); }
  let gone = -1;
  for (let d = 1; d <= 40 && gone < 0; d++) { g.p.live.dayNumber = d; (g.p as unknown as Fader).fadeAlliances(); if (!g.p.alliances.byId(g.pact)) gone = d; }
  Object.assign(xb(this), { g, n: gone });
});
Then("groups: the alliance fades by the same days an NPC one would, and the player is told by an event that names it and no roster", function () {
  const x = xb(this); const g = x.g as ReturnType<typeof playerPact>;
  assert.ok(x.n! > 0, "the player's alliance never faded");
  // an NPC pact over the same cold bonds fades on the same day
  const twin = stage(7, 3); const t = twin.ids.slice(5, 8);
  const npcPact = twin.p.alliances.add("Twin Pact", t[0]!, t, 1);
  for (const a of t) for (const b of t) if (a !== b) bond(twin.p, a, b, 0.1);
  let tg = -1; for (let d = 1; d <= 40 && tg < 0; d++) { twin.p.live.dayNumber = d; (twin.p as unknown as Fader).fadeAlliances(); if (!twin.p.alliances.byId(npcPact.id)) tg = d; }
  assert.equal(x.n, tg);
  assert.ok(kinds(g.p, "faded").some((e) => e.allianceId === g.pact));
  const ev = eventsOf(g.sb, "alliance-faded").filter((e) => e.content.includes(g.pactName));
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.witnessSet.includes(PLAYER) && ev[0]!.hidden === false);
  const nm = (id: EntityId) => (g.s as unknown as { nameOf(id: string): string }).nameOf(id);
  for (const m of g.npcs) assert.ok(!ev[0]!.content.includes(nm(m)), "the event lists a member");
});

function hostileMember(g: ReturnType<typeof playerPact>, holder: EntityId): void {
  g.p.live.agendas![holder]!.goals.push(hostileGoal(holder, g.p));
  bond(g.p, holder, PLAYER, 0.3, 0.9);
}
Given("groups: a season where a member of the player's alliance has a goal to get the player out", function () {
  const g = playerPact(7); const holder = g.npcs[0]!; hostileMember(g, holder);
  for (let d = 1; d <= 600 && g.p.alliances.byId(g.pact)!.members.includes(holder); d++) {
    g.p.live.dayNumber = d;
    for (const a of g.p.alliances.all()) { a.lowDays = 0; a.checkedDay = d; }
    (g.p as unknown as Fader).fadeAlliances();
  }
  Object.assign(xb(this), { g, teller: holder });
});
Then("groups: the member leaves and the player witnessed it as an event naming the alliance, never a roster", function () {
  const x = xb(this); const g = x.g as ReturnType<typeof playerPact>;
  assert.ok(!g.p.alliances.byId(g.pact)!.members.includes(x.teller!));
  const ev = eventsOf(g.sb, "betrayal").filter((e) => e.content.includes(g.pactName));
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.witnessSet.includes(PLAYER) && ev[0]!.hidden === false);
  const nm = (id: EntityId) => (g.s as unknown as { nameOf(id: string): string }).nameOf(id);
  for (const m of g.npcs.filter((m) => m !== x.teller)) assert.ok(!ev[0]!.content.includes(nm(m)), "the event lists a member");
});

Given("groups: a season where two members of the player's alliance have a goal to get the player out and the house is late", function () {
  for (let seed = 7; seed < 40; seed++) {
    const g = stage(seed, 4); const [a, b, c, d] = g.members as [EntityId, EntityId, EntityId, EntityId];
    g.p.live.evictionOrder = g.ids.filter((x) => !g.members.includes(x));
    const al = g.p.alliances.add("Player Pact", PLAYER, [PLAYER, ...g.members], 1);
    const gg = { ...g, npcs: g.members, pact: al.id, pactName: al.name } as ReturnType<typeof playerPact>;
    for (const [x, y] of [[a, c], [a, d], [c, d], [d, b], [b, a], [b, c]] as const) { bond(g.p, x, y, 0.85); bond(g.p, y, x, 0.85); }
    for (const x of [a, c]) hostileMember(gg, x);
    g.p.alliances.byId(g.id)!.members = []; // the stock pact is not part of this season
    for (let k = 0; k < 250 && g.p.live.groupLife?.[al.id]?.crackedDay === undefined; k++) day(g.p, g.ids, "backyard");
    if (g.p.live.groupLife?.[al.id]?.crackedDay !== undefined) { Object.assign(xb(this), { g: gg, teller: a }); return; }
  }
  assert.fail("the alliance never broke away");
});
Then("groups: the two break away into a new alliance, and the player witnessed it as an event that names the alliance and one name only", function () {
  const x = xb(this); const g = x.g as ReturnType<typeof playerPact>;
  const born = g.p.alliances.all().find((a) => a.id !== g.pact && a.members.includes(x.teller!))!;
  assert.deepEqual([...born.members].sort(), [g.npcs[0]!, g.npcs[2]!].sort());
  const ev = eventsOf(g.sb, "alliance-break-away");
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.witnessSet.includes(PLAYER) && ev[0]!.hidden === false && ev[0]!.content.includes(g.pactName));
  const nm = (id: EntityId) => (g.s as unknown as { nameOf(id: string): string }).nameOf(id);
  assert.equal(g.npcs.filter((m) => ev[0]!.content.includes(nm(m))).length, 1);
  assert.ok(!/aimed at/i.test(ev[0]!.content) && !ev[0]!.content.includes(nm(PLAYER)), "the leaver's hidden cut order is handed over as fact"); // the Auditor's wall fix (#2981)
  assert.ok(g.p.alliances.byId(g.pact)!.members.includes(PLAYER)); // the player's own alliance carries on
});
Then("groups: no view shows a roster, a role or a cut order of the player's alliance", async function () {
  const g = xb(this).g as ReturnType<typeof playerPact>;
  const blob = await surfaceBlob(g.sb);
  for (const k of WALLED) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
  assert.ok(!(PLAYER in g.p.live.groupLife![g.pact]!.roles));
});
