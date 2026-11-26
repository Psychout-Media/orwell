import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";

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
  for (let seed = 11; seed < 30; seed++) { const w = stage(seed, flag); if (w.s.live.goalApproaches?.[w.holder] && w.s.live.aimedAtPlayer?.some((r) => r.actor === w.holder && r.hostile)) return w; }
  // ORW-709: a hostile step is now raised only when it is addressed TO the player (it used to fire when the player was merely the step's subject, which is hidden scheming: see the ORW-709 tests). The planner rarely addresses a
  // get-them-out step to the player from another room, so these pins hand the engine exactly that step (the same entry `houseLifeStretch` makes) and keep testing what happens to the record.
  const w = stage(11, flag);
  if (!flag) return w;
  const day = w.s.live.dayNumber ?? w.s.live.week;
  (w.s as unknown as { noteAimedStep(p: object, hostile: boolean, day: number): void }).noteAimedStep({ actor: w.holder, goalId: `${w.holder}:week:get-them-out:d1`, goalKind: "get-them-out", kind: "confront", with: [PLAYER] }, true, day);
  (w.s.live.goalApproaches ??= {})[w.holder] = { desire: "probe", goalId: `${w.holder}:week:get-them-out:d1`, hour: 0 };
  return w;
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
    // ORW-709: a hostile step the player has not answered writes its fight when it CLOSES (a kind answer in between folds no conflict); a non-hostile one is written as it surfaces.
    expect(r.eventId).toBeUndefined();
    s.live.dayNumber = (s.live.dayNumber ?? s.live.week) + 5;
    s.aimedAtPlayerTick(sb.engine.events);
    const ev = sb.engine.events.queryAll().find((e) => e.id === r.eventId)!;
    expect(ev.type).toBe("conflict");
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

  it("ORW-905: an answer closes only a record that surfaced; an open hostile one the player never saw stays and is still ignored later", () => {
    const a = raised();
    const rec = () => a.s.live.aimedAtPlayer!.find((x) => x.actor === a.holder)!;
    expect(rec().status).toBe("open");
    a.s.notePlayerTalk([a.holder], "conversation", undefined); // the player talks to them, but never saw this step
    expect(rec().status).toBe("open");
    rec().status = "shown";
    a.s.live.dayNumber = (a.s.live.dayNumber ?? a.s.live.week) + 5;
    a.s.aimedAtPlayerTick(a.sb.engine.events);
    expect(rec().status).toBe("ignored");
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

describe("ORW-701: a repeated aimed step in the same hour never crashes house life", () => {
  type Seam = { noteAimedStep(p: object, hostile: boolean, day: number): void; live: P["live"] & { aimedSeq?: number } };
  const step = (holder: string) => ({ actor: holder, goalId: `${holder}:week:get-them-out:d1`, goalKind: "get-them-out", kind: "approach" });
  function answeredThenAimedAgain() {
    const { sb, s, holder } = raised();
    const q = s as unknown as Seam;
    const day = s.live.dayNumber ?? s.live.week;
    s.live.aimedAtPlayer!.find((x) => x.actor === holder)!.status = "shown";
    s.aimedAtPlayerTick(sb.engine.events); // the scene is written
    s.notePlayerTalk([holder], "conversation", undefined); // the player answers it
    q.noteAimedStep(step(holder), true, day); // the same goal aims again, same hour
    return { sb, s, q, holder, day };
  }
  it("answer, then the same goal aims again in the same hour: distinct ids, and the tick does not throw", () => {
    const { sb, s, holder } = answeredThenAimedAgain();
    const recs = s.live.aimedAtPlayer!.filter((x) => x.actor === holder);
    expect(recs.length).toBe(2);
    expect(new Set(recs.map((r) => r.id)).size).toBe(2);
    expect(recs[0]!.id.startsWith("aim:")).toBe(true);
    recs[1]!.status = "shown";
    expect(() => s.aimedAtPlayerTick(sb.engine.events)).not.toThrow();
    // ORW-709: the answered one wrote no fight; the unanswered hostile one writes its scene when it closes.
    expect(recs[0]!.eventId).toBeUndefined();
    s.live.dayNumber = (s.live.dayNumber ?? s.live.week) + 5;
    expect(() => s.aimedAtPlayerTick(sb.engine.events)).not.toThrow();
    expect(recs[1]!.eventId).toBeDefined();
  });
  it("heals a save already holding two records with one id: the tick completes and adopts the written scene", () => {
    const { sb, s, holder } = raised();
    const dup = { id: "aim:legacy:g:1:1", actor: holder, goalId: "g", step: "approach", hostile: false, day: 1, hour: 1 };
    s.live.aimedAtPlayer = [{ ...dup, status: "shown" }, { ...dup, status: "shown" }];
    expect(() => s.aimedAtPlayerTick(sb.engine.events)).not.toThrow();
    expect(s.live.aimedAtPlayer.map((r) => r.eventId)).toEqual(["aim:legacy:g:1:1:scene", "aim:legacy:g:1:1:scene"]);
    expect(sb.engine.events.queryAll().filter((e) => e.id === "aim:legacy:g:1:1:scene").length).toBe(1);
    s.live.dayNumber = (s.live.dayNumber ?? s.live.week) + 1;
    expect(() => s.aimedAtPlayerTick(sb.engine.events)).not.toThrow(); // house life continues
  });
  it("the id sequence survives snapshot and restore, never goes back, and a later record gets a fresh id", () => {
    const { sb, s, q, holder, day } = answeredThenAimedAgain();
    expect(q.live.aimedSeq).toBe(2);
    const snap = JSON.parse(JSON.stringify(sb.session.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor("aimed701-restored");
    sb2.session.restore(snap);
    const s2 = sb2.session as unknown as Seam;
    expect(s2.live.aimedSeq).toBe(2);
    s2.live.aimedAtPlayer!.forEach((r) => { r.status = "answered"; });
    s2.noteAimedStep(step(holder), true, day);
    const ids = s2.live.aimedAtPlayer!.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s2.live.aimedSeq).toBe(3);
    const back = JSON.parse(JSON.stringify(snap)); back.live.aimedSeq = 1;
    expect(sessionCoreSupersetViolation(back as never, snap as never)).toBe("aimedSeq");
    expect(s.live.aimedAtPlayer!.length).toBe(2);
  });
});
