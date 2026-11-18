import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { roomActLine, ACTIONS, type ActionKind } from "../../src/engine/houseLife";
import { ROOM_LIFE } from "../../src/engine/houseLifeConstants";
import type { GameEvent } from "../../src/domain/event";

// Feature 0198 (ORW-621). Roles only; a real played sandbox, the hourly stretch driven directly.
type S = {
  livingIds(): string[];
  houseLifeStretch(events: unknown, awakeIds: readonly string[], stretchIndex: number, knowledge?: unknown): unknown[];
  setRoomLifeEnabled(on: boolean): void;
  presence: Map<string, string>;
  live: { agendas?: Record<string, { goals: Array<{ id: string; kind: string }> }> };
  getMomentPrompt(req: object): unknown;
};
const ROOM = "living-room";

async function play(seed: number, flag: boolean, stretches: number, sameHour: boolean) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `room-life-bdd-${seed}-${flag}-${sameHour}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setRoomLifeEnabled(flag);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  const inRoom = npcs.slice(0, 4);
  for (const id of inRoom) s.presence.set(id, ROOM);
  for (const id of npcs.slice(4)) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, ROOM);
  const before = sb.engine.events.count();
  for (let i = 0; i < stretches; i++) s.houseLifeStretch(sb.engine.events, npcs, sameHour ? 3 : i, sb.engine.knowledge);
  const added = sb.engine.events.queryAll().slice(before);
  return { sb, s, inRoom, added, room: added.filter((e) => e.id.startsWith("roomlife:")) as GameEvent[] };
}
let g: Awaited<ReturnType<typeof play>>;
let off: Awaited<ReturnType<typeof play>>;

Given("room life: a played game with four houseguests in the player's room", async function () {
  g = await play(5, true, 60, false);
  off = await play(5, false, 60, false);
});
Then("room life: some of them take steps there as events the player witnessed, not hidden, and no step is the player's", function () {
  assert.ok(g.room.length > 0, "someone acts");
  for (const e of g.room) {
    assert.equal(e.hidden, false);
    assert.ok(e.witnessSet.includes(PLAYER));
    assert.notEqual(e.initiator, PLAYER);
  }
  assert.equal(g.added.filter((e) => e.initiator === PLAYER).length, 0);
});
Then("room life: a stretch repeated in the same hour never yields more than the cap, and a houseguest acts once", async function () {
  let any = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await play(seed, true, 25, true);
    const actors = r.room.map((e) => e.id.split("|")[1]!);
    assert.ok(actors.length <= ROOM_LIFE.perHour, `seed ${seed}: ${actors.length}`);
    assert.equal(new Set(actors).size, actors.length);
    any += actors.length;
  }
  assert.ok(any > 0, "the cap binds rather than the feature never firing");
});
Then("room life: nobody leaves the room and no goal or its reason is in the events, the prompt or what the player holds", function () {
  for (const id of g.inRoom) assert.equal(g.s.presence.get(id), ROOM);
  assert.equal(g.s.presence.get(PLAYER), ROOM);
  const goals = Object.values(g.s.live.agendas ?? {}).flatMap((a) => a.goals);
  assert.ok(goals.length > 0);
  const shown = JSON.stringify(g.room) + JSON.stringify(g.sb.engine.knowledge.knownTo(PLAYER));
  const prompt = JSON.stringify(g.s.getMomentPrompt({}));
  for (const x of goals) {
    assert.ok(!shown.includes(x.id) && !prompt.includes(x.id), `goal id ${x.id} shown`);
    assert.ok(!shown.includes(x.kind), `goal kind ${x.kind} shown`);
  }
});
Given("room life: the sight of a step", function () { /* pure */ });
Then("room life: a pitch, a plant and a plea all read as a word with someone, while cooking and a confrontation read as themselves", function () {
  const line = (kind: ActionKind): string => roomActLine({ actor: "a", kind, with: ["b"], manner: "warm" }, (id) => `Name-${id}`);
  for (const k of ["pitch", "plant", "beg"] as const) assert.equal(line(k), line("check-in"));
  assert.notEqual(line("cook"), line("check-in"));
  assert.notEqual(line("confront"), line("check-in"));
  assert.ok(ACTIONS.confront.fold === "conflict");
});
Then("room life: with the feature off no room step is recorded", function () {
  assert.equal(off.room.length, 0);
});
