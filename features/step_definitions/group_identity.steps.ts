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
