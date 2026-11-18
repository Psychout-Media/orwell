import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { noteToldLead, resolveToldLeads, recentWrongLeads, toldLeadsSuperset, TOLD_LEADS, type ToldLead } from "../../src/engine/toldLeads";
import { resolvePending } from "../../features/support/answerPending";

/** 0197 / ORW-631: a lead a houseguest gave the player is recorded and resolved by what the player later sees. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sighting = { room: string; tick: number; day: number; part: string; heading?: boolean };
type Hack = {
  presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; ceremony: { hoh?: EntityId };
  npcSightings: Map<EntityId, Map<EntityId, Sighting>> | null; lastSeenAt: Map<EntityId, unknown> | null; trackedSightings: Map<EntityId, unknown> | null;
  presenceTickCount: number; live: { dayNumber?: number; timeOfDay?: string; playedGame?: boolean; toldLeads?: ToldLead[] };
  agendaCharacterOf: (id: EntityId) => unknown; rel: { edge: (a: EntityId, b: EntityId) => { affinity: number } };
  captureSeenWhereabouts(): void; catchMisdirectionEnabled: boolean; seatOf: (id: EntityId) => string;
  captureNpcSightings(): void; noteNpcSighting(v: EntityId, s: EntityId, room: string, heading: boolean): void;
};

let n = 0;
function toNominations(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`mis631-${n++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (s.getGameState().phase === "nominations" && s.livingIds().length >= 14) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("never");
}

/** Player in the backyard with V (kitchen, in view) and X (living room, in view); S behind a bedroom door; everyone else asleep. */
function stage(): { s: GameSessionAdapter; h: Hack; V: EntityId; X: EntityId; S: EntityId } {
  const s = toNominations();
  const h = s as unknown as Hack;
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  const [V, X, S] = [npcs[0]!, npcs[1]!, npcs[2]!];
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], [V, "kitchen"], [X, "living-room"], [S, "bedroom-a"]];
  for (const id of npcs) if (!seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  h.awakeNow = () => new Set<EntityId>([PLAYER, V, X, S]);
  h.ceremony.hoh = npcs[5];
  h.npcSightings = null; h.lastSeenAt = null; h.trackedSightings = null; h.live.playedGame = true;
  return { s, h, V, X, S };
}
const entry = (s: GameSessionAdapter, id: EntityId) => s.whereabouts({ search: true, lookingFor: id })!.search!.houseguests.find((e) => e.id === id)!;
const sheet = (h: Hack, character: unknown, affinity: { player: number; subject: number }, V: EntityId, S: EntityId): void => {
  h.agendaCharacterOf = () => character;
  h.rel = { edge: (a: EntityId, b: EntityId) => ({ affinity: a === V && b === S ? affinity.subject : affinity.player }) };
};
const CANDID = { archetype: "hothead", strategyStyle: "emotional" };   // candor 0.95
const GUARDED = { archetype: "villain", strategyStyle: "strategic" };  // candor 0.05


const lead = (over: Partial<ToldLead> = {}): ToldLead => ({ key: "k", speaker: "a" as EntityId, subject: "b" as EntityId, toldRoom: "kitchen", misled: false, tick: 1, day: 1, part: "morning", ...over });
const sight = (over: Partial<Parameters<typeof resolveToldLeads>[1]> = {}) => ({ tick: 2, day: 1, seenRoomOf: () => undefined, roomInView: () => false, ...over });

describe("the pure record", () => {
  it("is idempotent per key, and a lead waits the tick it was told", () => {
    const list: ToldLead[] = [];
    expect(noteToldLead(list, lead())).toBe(true);
    expect(noteToldLead(list, lead({ toldRoom: "backyard" }))).toBe(false);
    expect(list).toHaveLength(1);
    expect(resolveToldLeads(list, sight({ tick: 1, seenRoomOf: () => "kitchen" }))).toEqual([]);
    expect(list[0]!.status).toBeUndefined();
  });
  it("held when the subject is seen in the named room; wrong when seen elsewhere; wrong when the named room is in view and empty; open when nothing is in view", () => {
    const a = [lead()]; resolveToldLeads(a, sight({ seenRoomOf: () => "kitchen" })); expect(a[0]!.status).toBe("held");
    const b = [lead()]; resolveToldLeads(b, sight({ seenRoomOf: () => "backyard" })); expect(b[0]).toMatchObject({ status: "wrong", foundRoom: "backyard" });
    const c = [lead()]; resolveToldLeads(c, sight({ roomInView: (r) => r === "kitchen" })); expect(c[0]!.status).toBe("wrong"); expect(c[0]!.foundRoom).toBeUndefined();
    const d = [lead()]; expect(resolveToldLeads(d, sight())).toEqual([]); expect(d[0]!.status).toBeUndefined();
  });
  it("lapses on a later day, shows only for a few ticks, and the record is append-only", () => {
    const a = [lead()]; resolveToldLeads(a, sight({ day: 2, seenRoomOf: () => "backyard" })); expect(a[0]!.status).toBe("lapsed");
    const b = [lead()]; resolveToldLeads(b, sight({ tick: 2, seenRoomOf: () => "backyard" }));
    expect(recentWrongLeads(b, 2 + TOLD_LEADS.noticeTicks - 1)).toHaveLength(1);
    expect(recentWrongLeads(b, 2 + TOLD_LEADS.noticeTicks)).toHaveLength(0);
    expect(toldLeadsSuperset(b, b)).toBe(true);
    expect(toldLeadsSuperset([], b)).toBe(false);
    expect(toldLeadsSuperset(undefined, undefined)).toBe(true);
  });
});

const ask = (s: GameSessionAdapter, id: EntityId) => s.whereabouts({ search: true, lookingFor: id })!.search!.houseguests.find((e) => e.id === id)!;
const next = (h: Hack): void => { h.presenceTickCount += 1; h.captureSeenWhereabouts(); };

describe("catching a told lead in the played game", () => {
  it("a misleading answer is recorded with the engine-only truth, and the player finding the person elsewhere settles it as wrong", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 1 }, V, S);
    const told = ask(s, S);
    expect(told.status).toBe("told");
    const rec = h.live.toldLeads![0]!;
    expect(rec).toMatchObject({ speaker: V, subject: S, toldRoom: told.room, truthRoom: "bedroom-a", misled: true });
    ask(s, S); expect(h.live.toldLeads).toHaveLength(1); // the same turn is the same lead
    expect(s.whereabouts()!.leadsFoundWrong, "nothing found yet").toBeUndefined();
    h.presence.set(S, "kitchen"); // the person walks into view
    next(h);
    const view = s.whereabouts()!.leadsFoundWrong!;
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ toldBy: { id: V }, about: { id: S }, saidRoom: told.room, foundRoom: "kitchen" });
    expect(rec.status).toBe("wrong");
  });

  it("the wall: a misled lead and a stale true lead read the same, and nothing hidden reaches the view", () => {
    const run = (character: unknown, aff: { player: number; subject: number }) => {
      const { s, h, V, S } = stage();
      h.noteNpcSighting(V, S, "storage-room", true);
      sheet(h, character, aff, V, S);
      ask(s, S);
      h.presence.set(S, "kitchen");
      next(h);
      return { view: s.whereabouts()!.leadsFoundWrong!, json: JSON.stringify(s.whereabouts()), h, S };
    };
    const misled = run(GUARDED, { player: 0, subject: 1 });
    const stale = run(CANDID, { player: 0.5, subject: 0.5 });
    expect(misled.h.live.toldLeads![0]!.misled).toBe(true);
    expect(stale.h.live.toldLeads![0]!.misled).toBe(false);
    expect(Object.keys(misled.view[0]!).sort()).toEqual(Object.keys(stale.view[0]!).sort());
    for (const r of [misled, stale]) {
      expect(r.json).not.toMatch(/misled|truthRoom|mislead|\blied\b|false lead/i);
      expect(r.view[0]!.fact).not.toMatch(/mislead|lied|lie\b|on purpose|meant/i);
    }
  });

  it("the named room in view without the person settles it as wrong with no found room; the lead drops off the read after a few ticks but stays in the record", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "kitchen", false); // V saw S in the kitchen (in the player's view)
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    const told = ask(s, S);
    expect(told.room).toBe("kitchen");
    next(h); // S is behind the bedroom door, the kitchen is in view and empty of S
    const v = s.whereabouts()!.leadsFoundWrong!;
    expect(v[0]!.foundRoom).toBeUndefined();
    expect(v[0]!.fact).toContain("was not there");
    for (let i = 0; i < TOLD_LEADS.noticeTicks; i++) h.presenceTickCount += 1;
    expect(s.whereabouts()!.leadsFoundWrong).toBeUndefined();
    expect(h.live.toldLeads).toHaveLength(1);
  });

  it("a lead that held is not shown", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "kitchen", false);
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    ask(s, S);
    h.presence.set(S, "kitchen");
    next(h);
    expect(h.live.toldLeads![0]!.status).toBe("held");
    expect(s.whereabouts()!.leadsFoundWrong).toBeUndefined();
  });

  it("flag off: nothing is recorded or shown; the search answer is unchanged", () => {
    const { s, h, V, S } = stage();
    h.catchMisdirectionEnabled = false;
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 1 }, V, S);
    expect(ask(s, S).status).toBe("told");
    h.presence.set(S, "kitchen"); next(h);
    expect(h.live.toldLeads).toBeUndefined();
    expect(s.whereabouts()!.leadsFoundWrong).toBeUndefined();
  });

  it("a headless game records nothing", () => {
    const { s, h, V, S } = stage();
    h.live.playedGame = false;
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 1 }, V, S);
    h.noteNpcSighting(V, S, "storage-room", true);
    ask(s, S);
    expect(h.live.toldLeads).toBeUndefined();
  });

  it("the record survives a save and restore", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 1 }, V, S);
    ask(s, S);
    const snap = JSON.parse(JSON.stringify(s.snapshot())) as { live?: { toldLeads?: ToldLead[] } };
    expect(snap.live?.toldLeads).toHaveLength(1);
    const again = new GameSessionAdapter();
    again.restore(JSON.parse(JSON.stringify(snap)) as never);
    expect((again.snapshot() as unknown as typeof snap).live?.toldLeads).toEqual(snap.live!.toldLeads);
  });
});
