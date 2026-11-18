import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { roomActLine, ACTIONS, type ActionKind } from "../../src/engine/houseLife";
import { ROOM_LIFE } from "../../src/engine/houseLifeConstants";
import type { GameEvent } from "../../src/domain/event";

/** ORW-621 (spec 0198): the people in the player's room live too. Roles only. */
type S = {
  livingIds(): string[];
  houseLifeStretch(events: unknown, awakeIds: readonly string[], stretchIndex: number, knowledge?: unknown): unknown[];
  setRoomLifeEnabled(on: boolean): void;
  presence: Map<string, string>;
  live: { agendas?: Record<string, { goals: Array<{ id: string; kind: string }> }> };
  getMomentPrompt(req: object): unknown;
};
const ROOM = "living-room";

async function crowdedRoom(seed: number, flag: boolean, stretches = 60, sameHour = false) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `room-life-${seed}-${flag}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setRoomLifeEnabled(flag);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  const inRoom = npcs.slice(0, 4);
  const away = npcs.slice(4);
  for (const id of inRoom) s.presence.set(id, ROOM);
  for (const id of away) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, ROOM);
  const before = sb.engine.events.count();
  for (let i = 0; i < stretches; i++) s.houseLifeStretch(sb.engine.events, [...inRoom, ...away], sameHour ? 3 : i, sb.engine.knowledge);
  const added = sb.engine.events.queryAll().slice(before);
  const room = added.filter((e) => e.id.startsWith("roomlife:")) as GameEvent[];
  return { sb, s, inRoom, away, added, room };
}

describe("the people in your room live too (ORW-621, spec 0198)", () => {
  it("houseguests in the player's room take steps there as witnessed, not-hidden events with the player in the witness set", async () => {
    const r = await crowdedRoom(5, true);
    expect(r.room.length, "someone in the room acts").toBeGreaterThan(0);
    for (const e of r.room) {
      expect(e.hidden).toBe(false);
      expect(e.witnessSet).toContain(PLAYER);
      expect(e.initiator).not.toBe(PLAYER);
      for (const w of e.witnessSet.filter((x) => x !== PLAYER)) expect(r.s.presence.get(w), "only people in the player's room take part").toBe(ROOM);
      expect(e.houseLife, "no engine-only record rides a witnessed event").toBeUndefined();
    }
    expect(r.added.filter((e) => e.initiator === PLAYER)).toHaveLength(0); // the player never acts
  }, 120_000);

  it("is capped per in-game hour and per stretch, and a houseguest acts at most once an hour", async () => {
    let any = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = await crowdedRoom(seed, true, 25, true); // twenty-five stretches in the SAME hour
      const actors = r.room.map((e) => e.id.split("|")[1]!);
      expect(actors.length).toBeLessThanOrEqual(ROOM_LIFE.perHour);
      expect(new Set(actors).size).toBe(actors.length);
      any += actors.length;
    }
    expect(any, "the cap binds rather than the feature never firing").toBeGreaterThan(0);
    const spread = await crowdedRoom(7, true, 120); // many different hours: a bounded few, not every stretch
    expect(spread.room.length).toBeLessThan(80);
  }, 240_000);

  it("nobody is moved: the player and every houseguest are where they were", async () => {
    const r = await crowdedRoom(11, true, 30);
    expect(r.s.presence.get(PLAYER)).toBe(ROOM);
    for (const id of r.inRoom) expect(r.s.presence.get(id), "a step in the room never walks anyone out of it").toBe(ROOM);
  }, 120_000);

  it("hidden goal reasons never appear: the events, the prompt and what the player holds carry the act and the manner only", async () => {
    const r = await crowdedRoom(5, true);
    const goals = Object.values(r.s.live.agendas ?? {}).flatMap((a) => a.goals);
    expect(goals.length).toBeGreaterThan(0);
    const shown = JSON.stringify(r.room) + JSON.stringify(r.sb.engine.knowledge.knownTo(PLAYER));
    const prompt = JSON.stringify(r.s.getMomentPrompt({}));
    for (const g of goals) {
      expect(shown.includes(g.id), g.id).toBe(false);
      expect(prompt.includes(g.id), g.id).toBe(false);
      expect(shown.includes(g.kind), g.kind).toBe(false);
    }
    for (const bad of ["goalId", "goalKind", "agenda", "truthful", "houseLife"]) expect(shown.includes(bad), bad).toBe(false);
    expect(r.sb.engine.knowledge.knownTo(PLAYER).filter((f) => f.pathway === "witnessed").length, "the player holds what they saw").toBeGreaterThan(0);
  }, 120_000);

  it("flag off writes no room step and replays byte-identically", async () => {
    const off = await crowdedRoom(5, false);
    expect(off.room).toHaveLength(0);
    const again = await crowdedRoom(5, false);
    expect(JSON.stringify(off.added)).toBe(JSON.stringify(again.added));
  }, 120_000);

  it("is deterministic: the same seed plays the same room", async () => {
    const a = await crowdedRoom(13, true, 40);
    const b = await crowdedRoom(13, true, 40);
    expect(a.room.map((e) => [e.id, e.content, e.type])).toEqual(b.room.map((e) => [e.id, e.content, e.type]));
  }, 120_000);

  it("a goal step shows as a plain word with someone, never as what it is for; house life and clashes show as themselves", () => {
    const name = (id: string): string => `Name-${id}`;
    const line = (kind: ActionKind): string => roomActLine({ actor: "a", kind, with: ["b"], manner: "warm" }, name);
    const agendaKinds = (Object.keys(ACTIONS) as ActionKind[]).filter((x) => ACTIONS[x].fold !== "conflict" && (ACTIONS[x].family === "information" || ACTIONS[x].family === "alliances" || ACTIONS[x].family === "safety" || ACTIONS[x].family === "attack"));
    expect(agendaKinds.length).toBeGreaterThan(10);
    for (const k of agendaKinds) expect(line(k), k).toBe(line("check-in"));
    expect(line("cook")).not.toBe(line("check-in"));
    expect(line("confront")).not.toBe(line("check-in"));
    expect(line("pitch")).toContain("Name-a");
    expect(line("pitch")).toContain("(warm)");
    expect(roomActLine({ actor: "a", kind: "gossip", with: ["b"], manner: "cold", about: "c" } as never, name)).not.toContain("Name-c");
  });
});
