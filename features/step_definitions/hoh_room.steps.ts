import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { decideVisit, backstoryFacets, pickBackstoryFact, actingSkill, type GuestInput } from "../../src/engine/hohRoom";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { GameEvent } from "../../src/domain/event";

// Feature 0199 (ORW-629). Roles only. The visit is pure, so most scenarios drive `decideVisit` over many seeds; the wall and the flag scenarios use a real played sandbox.
const HOH = "npc:1";
let shape: Partial<GuestInput> = {};
let events: GameEvent[] = [];
const cast = (k: number, over: Partial<GuestInput> = {}): GuestInput[] => Array.from({ length: k }, (_, i) => ({ id: `npc:${i + 10}`, social: 0.5, affinity: 0.25, threat: 0.1, grudge: 0, ...over }));
const seeds = Array.from({ length: 300 }, (_, i) => i + 1);

Given("hoh room: a house of invited guests with ordinary feelings toward the new HOH", function () { shape = {}; });
Given("hoh room: a house of invited guests with a strong grudge against the new HOH", function () { shape = { affinity: -0.25, grudge: 1 }; });
Given("hoh room: guests who resent the new HOH", function () { shape = { affinity: -0.2 }; });
Given("hoh room: a houseguest whose public backstory is on file", function () { shape = {}; });

Then("hoh room: every guest is invited, each one either comes or skips, and across many seasons skipping is rare", function () {
  let skips = 0, total = 0;
  for (const s of seeds) {
    const g = cast(14, shape);
    const v = decideVisit(s, 2, HOH, g);
    assert.equal(v.invited.length, 14);
    assert.equal(v.attended.length + v.snubbed.length, 14);
    skips += v.snubbed.length; total += 14;
  }
  assert.ok(skips / total < 0.04, `skip rate ${skips / total}`);
});
Then("hoh room: across many seasons some skip and most still come", function () {
  let skips = 0, total = 0;
  for (const s of seeds) { skips += decideVisit(s, 2, HOH, cast(14, shape)).snubbed.length; total += 14; }
  assert.ok(skips > 0 && skips / total < 0.5, `skip rate ${skips / total}`);
});
Then("hoh room: the best actors slip less often than the worst, and a guest with nothing against the HOH never slips", function () {
  const slips = (social: number, over: Partial<GuestInput>): number => seeds.reduce((n, s) => n + decideVisit(s, 2, HOH, [{ id: "npc:10", social, affinity: 0.25, threat: 0.1, ...shape, ...over }]).slipped.length, 0);
  assert.ok(actingSkill(5, "npc:10", 1) > actingSkill(5, "npc:10", 0));
  assert.ok(slips(1, {}) < slips(0, {}));
  assert.equal(slips(0, { affinity: 0.9, threat: 0 }), 0);
});
Then("hoh room: every revealed fact is one the character itself carries and none repeats", function () {
  const c = { vocation: "ER nurse", hometown: "Dayton, OH", biography: "She grew up caring for her brothers. She never finished the degree she started." };
  const facets = backstoryFacets(c);
  const used = new Set<string>();
  const own = Object.values(c).join(" ");
  for (let w = 0; w < facets.length; w++) { const f = pickBackstoryFact(3, HOH, w, facets, used); assert.ok(f && own.includes(f.text) && !used.has(f.text)); used.add(f.text); }
  assert.equal(pickBackstoryFact(3, HOH, 99, facets, used), undefined);
});

type S = { recordHohRoom(h: string): void; setHohRoomEnabled(on: boolean): void; livingIds(): string[]; live: { hohRoom?: unknown }; getGameState(): unknown; getMomentPrompt(o: object): unknown;
  rel: { edge(a: string, b: string): { affinity: number; threat: number } } };
let sess: S | undefined;
async function played(on: boolean): Promise<void> {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 5 }).registry;
  const user = `hoh-room-bdd-${on}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setHohRoomEnabled(on);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  for (const id of npcs.slice(1)) { const e = s.rel.edge(id, npcs[0]!); e.affinity = -0.25; e.threat = 0.7; }
  const before = sb.engine.events.count();
  s.recordHohRoom(npcs[0]!);
  events = sb.engine.events.queryAll().slice(before).filter((e) => e.type === "hoh-room");
  sess = s;
}
Given("hoh room: a played game where the new HOH is crowned and the house resents them", async function () { await played(true); });
Given("hoh room: a played game with the feature switched off", async function () { await played(false); });
Then("hoh room: the visit events name only who came, who skipped, who slipped and which way, and no surface shows a number or the mask", function () {
  assert.ok(events.length > 0);
  const all = events.map((e) => e.content).join(" ") + JSON.stringify(sess!.getGameState()) + JSON.stringify(sess!.getMomentPrompt({}));
  assert.ok(!/\d\.\d/.test(events.map((e) => e.content).join(" ")), "a number crossed");
  assert.ok(!/acting|mask skill|"affinity"|"threat"/i.test(all), "a hidden field crossed");
});
Then("hoh room: no visit is recorded and nothing is saved", function () {
  assert.equal(events.length, 0);
  assert.equal(sess!.live.hohRoom, undefined);
});
