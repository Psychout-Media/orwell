import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { habitRoom, pairKey } from "../../src/engine/groupIdentity";
import type { Room } from "../../src/domain/house";
import type { HouseCulture } from "../../src/engine/npcMindsAuthored";

/** Feature 0183 - private habits and group identity, parts a and b (ORW-566). Drives the REAL adapter. Roles only. */
type Priv = {
  live: { lastCeremonyAbsHour?: number };
  alliances: { add(n: string, f: string, m: string[], b: number): unknown };
  presence: Map<string, Room>;
  houseLifeStretch(e: unknown, ids: string[], i: number): Array<{ event: { houseLife?: { action: string; habit?: string; seenBy?: string[] } } }>;
  inGameAbsHour(): number | undefined;
  house: { npcs: Array<{ id: string }>; player: { id: string } };
  perceivedBond(h: string, a: string, b: string): number;
  houseAllianceName(t: string, f: string): string;
};
type Bag = { counts?: Record<string, number>; sb?: UserSandbox; s?: GameSessionAdapter; p?: Priv; a?: string; b?: string; third?: string; stranger?: string; key?: string; blob?: string };
const bag = (w: unknown): Bag => ((w as { gi0183?: Bag }).gi0183 ??= {});
let n = 0;
function stage(seed: number, ago: number | undefined, flag = true, close = true) {
  const sb = new GameSessionRegistry().sandboxFor(`gi0183-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGroupIdentityEnabled(flag);
  sb.session.noteMessage({ messageId: "m1" });
  const p = sb.session as unknown as Priv;
  const ids = p.house.npcs.map((x) => x.id);
  const [a, b] = [ids[0]!, ids[1]!];
  if (close) p.alliances.add("Pair", a, [a, b], 1);
  const spot = habitRoom(seed, pairKey(a, b), undefined);
  const pr = p.presence.get(p.house.player.id);
  const away = (["kitchen", "living-room", "dining-room", "backyard", "bedroom-a", "bedroom-b"] as Room[]).find((r) => r !== spot && r !== pr)!;
  for (const id of ids) p.presence.set(id, id === b && spot !== pr ? spot : away);
  const now = p.inGameAbsHour();
  if (ago !== undefined && now !== undefined) p.live.lastCeremonyAbsHour = now - ago;
  return { sb, s: sb.session, p, ids, a, b, spot, now };
}
const meets = (g: ReturnType<typeof stage>): number =>
  g.now === undefined ? 0 : g.p.houseLifeStretch(g.sb.engine.events, g.ids, 1).filter((x) => x.event.houseLife?.action === "debrief").length;
const across = (f: (seed: number) => number): number => { let t = 0; for (let seed = 1; seed <= 40; seed++) t += f(seed); return t; };

Given("two close allies, one already at their spot, in the hours after a ceremony", function () { bag(this).counts = { meets: across((s) => meets(stage(s, 0))) }; });
Given("two close allies, one already at their spot, long after the last ceremony", function () {
  bag(this).counts = { late: across((s) => meets(stage(s, 50))), off: across((s) => meets(stage(s, 0, false))), cold: across((s) => meets(stage(s, 0, true, false))) };
});
Then("across seasons the pair meet there for a debrief", function () { assert.ok(bag(this).counts!["meets"]! > 0); });
Then("across seasons the pair never meet there", function () { assert.equal(bag(this).counts!["late"], 0); });
Then("two houseguests who are not close never keep a habit even right after a ceremony", function () { assert.equal(bag(this).counts!["cold"], 0); });
Then("with the feature off the pair never meet there", function () { assert.equal(bag(this).counts!["off"], 0); });

Given("two close allies who meet at a public spot while a third houseguest is in the room", function () {
  for (let seed = 1; seed <= 60; seed++) {
    const g = stage(seed, 0);
    if (g.now === undefined) continue;
    const third = g.ids[2]!, stranger = g.ids[3]!;
    g.p.presence.set(third, g.spot);
    const res = g.p.houseLifeStretch(g.sb.engine.events, g.ids.filter((x) => x !== third), 1).filter((x) => x.event.houseLife?.action === "debrief");
    if (res.length > 0) { Object.assign(bag(this), { s: g.s, p: g.p, a: g.a, b: g.b, third, stranger }); return; }
  }
  assert.fail("no seed fired");
});
Then("the third houseguest reads the pair as closer than a houseguest who did not see it", function () {
  const { p, a, b, third, stranger } = bag(this);
  assert.ok(p!.perceivedBond(third!, a!, b!) > p!.perceivedBond(stranger!, a!, b!));
});

Given("a house that has authored a nickname for a room", function () {
  const g = stage(5, undefined);
  (g.p as unknown as { live: { npcMindsAuthored?: { culture?: HouseCulture } } }).live.npcMindsAuthored = { culture: { spots: [{ room: "kitchen", nickname: "the Pantry" }], rituals: [] } };
  g.p.presence.set(g.a, "kitchen");
  Object.assign(bag(this), { p: g.p, a: g.a });
});
Then("an alliance founded in that room takes the nickname", function () { assert.equal(bag(this).p!.houseAllianceName("Stock Name", bag(this).a!), "the Pantry"); });
Then("a house with no authored words keeps the stock name", function () {
  const g = stage(5, undefined);
  assert.equal(g.p.houseAllianceName("Stock Name", g.a), "Stock Name");
});

Given("two close allies who have kept their habit", async function () {
  for (let seed = 1; seed <= 60; seed++) {
    const g = stage(seed, 0);
    if (g.now === undefined) continue;
    if (g.p.houseLifeStretch(g.sb.engine.events, g.ids, 1).some((x) => x.event.houseLife?.action === "debrief")) { Object.assign(bag(this), { sb: g.sb, key: pairKey(g.a, g.b) }); return; }
  }
  assert.fail("no seed fired");
});
Then("no player or admin view shows a habit, a spot key or a group identity", async function () {
  const { sb, key } = bag(this);
  const surfaces = [
    await sb!.mcp.player.callTool("getGameState", {}), await sb!.mcp.player.callTool("gameStatus", {}), await sb!.mcp.player.callTool("getMomentPrompt", {}),
    await sb!.mcp.player.callTool("seasonRecap", {}), await sb!.mcp.player.callTool("whereabouts", {}), await sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ];
  const blob = JSON.stringify(surfaces);
  for (const k of ["groupIdentity", "pairHabits", "lastCeremonyAbsHour", '"habit"', key!]) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
});

// ---- Part c2 (ORW-566): formation-time alliance naming through the anonymized sealed-prompt door ----
type Priv2 = Omit<Priv, "live"> & { live: { dayNumber?: number; week: number; groupIdentity?: Record<string, { sealed?: { name: string; floor: string; authored: boolean } }> }; noteAllianceIdentity(id: string, n: string, f: string): void };
const addAlliance = (p: Priv2, n: string, f: string, m: string[]): { id: string; name: string } => p.alliances.add(n, f, m, 1) as { id: string; name: string };
function night(s: GameSessionAdapter, p: Priv2): void { p.live.dayNumber = (p.live.dayNumber ?? p.live.week) + 1; s.settleOvernight(1); }
Given("an alliance of houseguests has formed in a played game", function () {
  const g = stage(7, undefined, true, false);
  const p = g.p as unknown as Priv2;
  const al = addAlliance(p, "Stock Pact", g.a, [g.a, g.b]);
  p.noteAllianceIdentity(al.id, al.name, g.a);
  Object.assign(bag(this), { s: g.s, sb: g.sb, p: g.p, key: al.id });
});
Then("it holds a floor name from the moment it formed", function () {
  const p = bag(this).p as unknown as Priv2;
  assert.deepEqual(p.live.groupIdentity![bag(this).key!]!.sealed, { name: "Stock Pact", floor: "Stock Pact", authored: false });
});
Then("a name the members author later replaces the floor once and shows up in no player or admin view", async function () {
  const { s, key } = bag(this);
  const p = bag(this).p as unknown as Priv2;
  night(s!, p);
  const t = Object.entries((p.live as unknown as { nameTickets: Record<string, { kind: string; allianceId?: string }> }).nameTickets).find(([, x]) => x.kind === "real" && x.allianceId === key)![0];
  assert.deepEqual(s!.recordAllianceName({ ticket: t, name: "Zzsentinel Lanterns" }), { accepted: true });
  assert.equal(p.live.groupIdentity![key!]!.sealed!.name, "Zzsentinel Lanterns");
  assert.deepEqual(s!.recordAllianceName({ ticket: t, name: "Again" }), { accepted: false });
  const seen = JSON.stringify([s!.allianceNameTickets(), s!.groupsAwaitingWords(), await bag(this).sb!.mcp.player.callTool("getGameState", {})]);
  assert.ok(!seen.includes("entinel"));
});
Given("one night with no new alliance and one night with a new alliance", function () {
  const shapes: string[] = [];
  for (const formed of [false, true]) {
    const g = stage(7, undefined, true, false);
    const p = g.p as unknown as Priv2;
    if (formed) { const al = addAlliance(p, "Stock Pact", g.a, [g.a, g.b]); p.noteAllianceIdentity(al.id, al.name, g.a); }
    night(g.s, p);
    const out = g.s.allianceNameTickets();
    shapes.push(JSON.stringify(out.map((o) => [Object.keys(o).join(","), o.prompt.split("\n").length, (JSON.parse(o.prompt.split("\n")[1]!) as { sharedTraits: string[] }).sharedTraits.length])));
    if (!formed) bag(this).blob = JSON.stringify(out);
    else bag(this).blob += JSON.stringify(out) + `|${g.a}|${g.b}`;
  }
  bag(this).counts = { same: shapes[0] === shapes[1] ? 1 : 0 };
});
Then("both nights hand the writer the same number of tickets with the same shape", function () { assert.equal(bag(this).counts!["same"], 1); });
Then("no ticket names a member, a count, a room or a day", function () {
  const [blob, a, b] = bag(this).blob!.split("|");
  assert.ok(!blob!.includes(a!) && !blob!.includes(b!) && !/alliance|room|day \d|week \d/i.test(blob!.split("\\n").filter((_, i) => i % 2 === 1).join(" ")));
});
