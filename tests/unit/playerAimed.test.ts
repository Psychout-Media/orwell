import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";

/**
 * ORW-611 (0172 / 0173): a houseguest's goal step aimed at the player is RECORDED (a witnessed event once it surfaces), answerable like one aimed at an NPC, and a hostile one the player ignores
 * costs that houseguest's read of them. Roles only (holder, player).
 */
type Rec = { id: string; actor: string; hostile: boolean; status: string; eventId?: string; goalKind?: string };
type P = {
  livingIds(): EntityId[];
  noteMessage(a: object): unknown;
  houseLifeStretch(events: unknown, awake: readonly EntityId[], i: number): unknown[];
  aimedAtPlayerTick(events: unknown): void;
  setPlayerAimedEnabled(on: boolean): void;
  setGroupRolesEnabled(on: boolean): void;
  notePlayerTalk(withIds: readonly EntityId[], kind: string | undefined, named: EntityId | undefined): void;
  createCharacter(a: object): unknown;
  presence: Map<EntityId, string>;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number; threat: number } };
  live: { week: number; dayNumber?: number; nightDepth?: number; playedGame?: boolean; aimedAtPlayer?: Rec[]; aimedAtPlayerDay?: number; goalApproaches?: Record<string, unknown>; agendas?: Record<string, { goals: Goal[] }> };
};
let n = 0;
function stage(seed: number, flag = true) {
  const sb = new GameSessionRegistry().sandboxFor(`aimed611-${n++}`);
  const s = sb.session as unknown as P;
  s.createCharacter({ playerName: "The Player", seed });
  s.setPlayerAimedEnabled(flag);
  s.setGroupRolesEnabled(true);
  s.noteMessage({ messageId: "m1" });
  const ids = s.livingIds().filter((i) => i !== PLAYER);
  const holder = ids[0]!;
  s.live.agendas![holder]!.goals.push({ id: `${holder}:week:get-them-out:d1`, owner: holder, horizon: "week", kind: "get-them-out", target: PLAYER, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week } as unknown as Goal);
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "kitchen");
  const e = s.rel.edge(holder, PLAYER); e.trust = 0.1; e.affinity = 0.1; e.threat = 0.9;
  const awake = [...ids.slice(0, 4), PLAYER] as EntityId[];
  for (let i = 0; i < 14 && !s.live.goalApproaches?.[holder]; i++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, i); }
  return { sb, s, holder };
}
function raised(flag = true) {
  for (let seed = 11; seed < 30; seed++) { const w = stage(seed, flag); if (w.s.live.goalApproaches?.[w.holder]) return w; }
  throw new Error("no seed raised the approach");
}

describe("a step aimed at the player is recorded", () => {
  it("a hostile goal step names the goal kind and is open; the approach is raised alongside it", () => {
    const { s, holder } = raised();
    const r = s.live.aimedAtPlayer!.find((x) => x.actor === holder)!;
    expect(r).toMatchObject({ hostile: true, status: "open", goalKind: "get-them-out" });
    expect(s.live.aimedAtPlayer!.filter((x) => x.actor === holder).length).toBe(1);
  });

  it("when it surfaces, the tick writes a witnessed (never hidden) event with the player in the witness set", () => {
    const { sb, s, holder } = raised();
    s.live.aimedAtPlayer!.find((x) => x.actor === holder)!.status = "shown";
    s.aimedAtPlayerTick(sb.engine.events);
    const r = s.live.aimedAtPlayer!.find((x) => x.actor === holder)!;
    const ev = sb.engine.events.queryAll().find((e) => e.id === r.eventId)!;
    expect(ev.hidden).toBe(false);
    expect(ev.witnessSet).toEqual(expect.arrayContaining([PLAYER, holder]));
    s.aimedAtPlayerTick(sb.engine.events);
    expect(sb.engine.events.queryAll().filter((e) => e.id === r.eventId).length).toBe(1); // written once
  });

  it("an ignored hostile approach costs that houseguest's read of the player; an answered one does not; nothing is removed", () => {
    const a = raised();
    const before = { ...a.s.rel.edge(a.holder, PLAYER) };
    a.s.live.aimedAtPlayer!.find((x) => x.actor === a.holder)!.status = "shown";
    a.s.live.dayNumber = (a.s.live.dayNumber ?? a.s.live.week) + 5;
    a.s.aimedAtPlayerTick(a.sb.engine.events);
    const closed = a.s.live.aimedAtPlayer!.find((x) => x.actor === a.holder)!;
    expect(closed.status).toBe("ignored");
    expect(a.s.rel.edge(a.holder, PLAYER).trust).toBeLessThan(before.trust + 1e-9);
    expect(a.s.rel.edge(a.holder, PLAYER).threat).toBeGreaterThanOrEqual(before.threat);
    const b = raised();
    b.s.live.aimedAtPlayer!.find((x) => x.actor === b.holder)!.status = "shown";
    const edge = { ...b.s.rel.edge(b.holder, PLAYER) };
    b.s.notePlayerTalk([b.holder], "conversation", undefined);
    b.s.live.dayNumber = (b.s.live.dayNumber ?? b.s.live.week) + 5;
    b.s.aimedAtPlayerTick(b.sb.engine.events);
    expect(b.s.live.aimedAtPlayer!.find((x) => x.actor === b.holder)!.status).toBe("answered");
    expect(b.s.rel.edge(b.holder, PLAYER)).toEqual(edge);
  });

  it("the record survives a persistence round trip", () => {
    const { s, holder } = raised();
    const copy = JSON.parse(JSON.stringify(s.live.aimedAtPlayer)) as Rec[];
    expect(copy.find((x) => x.actor === holder)).toMatchObject({ hostile: true });
  });

  it("flag off: nothing is recorded and no event is written", () => {
    const { sb, s } = raised(false);
    expect(s.live.aimedAtPlayer).toBeUndefined();
    s.aimedAtPlayerTick(sb.engine.events);
    expect(s.live.aimedAtPlayerDay).toBeUndefined();
  });
});
