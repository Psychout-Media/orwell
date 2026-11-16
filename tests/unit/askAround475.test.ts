import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { askDisposition } from "../../src/engine/askAround";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-475: each houseguest keeps their own record of who they saw go where and answers asked-around questions from it; tells / dodges / misleads comes from their sheet. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sighting = { room: string; tick: number; day: number; part: string; heading?: boolean };
type Hack = {
  presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; ceremony: { hoh?: EntityId };
  npcSightings: Map<EntityId, Map<EntityId, Sighting>> | null; lastSeenAt: Map<EntityId, unknown> | null; trackedSightings: Map<EntityId, unknown> | null;
  presenceTickCount: number; live: { dayNumber?: number; timeOfDay?: string };
  agendaCharacterOf: (id: EntityId) => unknown; rel: { edge: (a: EntityId, b: EntityId) => { affinity: number } };
  captureNpcSightings(): void; noteNpcSighting(v: EntityId, s: EntityId, room: string, heading: boolean): void;
};

let n = 0;
function toNominations(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`ask475-${n++}`).session;
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
  h.npcSightings = null; h.lastSeenAt = null; h.trackedSightings = null;
  return { s, h, V, X, S };
}
const entry = (s: GameSessionAdapter, id: EntityId) => s.whereabouts({ search: true, lookingFor: id })!.search!.houseguests.find((e) => e.id === id)!;
const sheet = (h: Hack, character: unknown, affinity: { player: number; subject: number }, V: EntityId, S: EntityId): void => {
  h.agendaCharacterOf = () => character;
  h.rel = { edge: (a: EntityId, b: EntityId) => ({ affinity: a === V && b === S ? affinity.subject : affinity.player }) };
};
const CANDID = { archetype: "hothead", strategyStyle: "emotional" };   // candor 0.95
const GUARDED = { archetype: "villain", strategyStyle: "strategic" };  // candor 0.05

describe("the pure sheet rule", () => {
  it("a candid houseguest always tells; a guarded one protects someone they like more than the player and is evasive with a player they do not warm to", () => {
    for (const roll of [0, 0.3, 0.99]) expect(askDisposition({ candor: 1, affinityToPlayer: 0, affinityToSubject: 1 }, roll)).toBe("tells");
    expect(askDisposition({ candor: 0, affinityToPlayer: 0, affinityToSubject: 1 }, 0.5)).toBe("misleads");  // protects a friend over a stranger
    expect(askDisposition({ candor: 0, affinityToPlayer: 0, affinityToSubject: 0 }, 0.1)).toBe("dodges");    // evasive with a player they do not warm to
    expect(askDisposition({ candor: 0, affinityToPlayer: 0, affinityToSubject: 0 }, 0.9)).toBe("tells");     // not always
    expect(askDisposition({ candor: 0, affinityToPlayer: 1, affinityToSubject: 0 }, 0.01)).toBe("tells");    // fond of the player: tells
  });
});

describe("each houseguest's own record", () => {
  it("records only what they could see: a houseguest sees the ones in their room and in sightline, never one behind a door", () => {
    const { h, V, X, S } = stage();
    h.captureNpcSightings();
    expect(h.npcSightings!.get(V)!.get(X)).toMatchObject({ room: "living-room" }); // the living room is in the kitchen's sightline
    expect(h.npcSightings!.get(V)!.get(S), "V cannot see into bedroom A").toBeUndefined();
    expect(h.npcSightings!.get(S)?.get(V), "S cannot see out of a closed bedroom").toBeUndefined();
  });

  it("the record survives a save and restore; an older save loads empty; a headless game never writes it", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`ask475-${n++}`).session;
    s.createCharacter({ playerName: "P", seed: 6 });
    s.noteMessage({ messageId: "m1" });
    for (let i = 0; i < 10; i++) s.noteMessage({ messageId: `m-${i}` });
    const snap = JSON.parse(JSON.stringify(s.snapshot())) as { npcSightings?: Record<string, unknown> };
    expect(Object.keys(snap.npcSightings ?? {}).length, "someone saw someone").toBeGreaterThan(0);
    const again = new GameSessionAdapter();
    again.restore(JSON.parse(JSON.stringify(snap)) as never);
    expect((again.snapshot() as unknown as typeof snap).npcSightings).toEqual(snap.npcSightings);
    delete snap.npcSightings;
    const old = new GameSessionAdapter();
    old.restore(snap as never);
    expect((old.snapshot() as unknown as typeof snap).npcSightings).toBeUndefined();
    const headless = new GameSessionRegistry().sandboxFor(`ask475-${n++}`).session;
    headless.createCharacter({ playerName: "P", seed: 6 });
    headless.advanceGame();
    expect((headless.snapshot() as unknown as typeof snap).npcSightings, "headless saves stay byte-identical").toBeUndefined();
  });
});

describe("asking around", () => {
  it("truthful: a candid houseguest who saw them go says where, in their own voice, as a lead the player can check", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    const e = entry(s, S);
    expect(e).toMatchObject({ status: "told", room: "storage-room", toldBy: { id: V } });
    expect(e.fact).toContain("was heading into the storage room");
    expect(e.fact).toContain("may be out of date");
  });

  it("stale: the memory is where they were, not where they are now", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true); // S is now in bedroom A (the staged truth)
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    expect(entry(s, S).room).toBe("storage-room");
    expect(h.presence.get(S)).toBe("bedroom-a");
  });

  it("haven't seen him: nobody present has a record, so the answer is unknown and names no room", () => {
    const { s, h, V, S } = stage();
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    const e = entry(s, S);
    expect(e.status).toBe("unknown");
    expect(e.room).toBeUndefined();
  });

  it("an answer never contains a room nobody present has a record of: a full roster sweep with no sightings gives only what is in view", () => {
    const { s, h, V, S } = stage();
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    const inView = new Set([...s.whereabouts()!.present, ...s.whereabouts()!.nearby.flatMap((r) => r.present)].map((p) => p.id));
    for (const id of s.livingIds().filter((x) => x !== PLAYER)) {
      const e = entry(s, id);
      if (e.room !== undefined) expect(inView.has(id), `${id} named in ${e.room}`).toBe(true);
      expect(e.status).not.toBe("told");
    }
  });

  it("the player's own record wins when it is as fresh", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    h.lastSeenAt = new Map([[S, { room: "kitchen", tick: h.presenceTickCount + 5, day: h.live.dayNumber ?? 1, part: "afternoon" }]]);
    sheet(h, CANDID, { player: 0.5, subject: 0.5 }, V, S);
    expect(entry(s, S)).toMatchObject({ status: "lead", room: "kitchen" });
  });

  it("a sheet-driven dodge: a guarded houseguest cold to the player gives no straight answer on some turns and tells on others, deterministically", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 0 }, V, S);
    const seen = new Set<string>();
    for (let day = 1; day <= 40; day++) {
      h.live.dayNumber = day;
      const a = entry(s, S); const b = entry(s, S);
      expect(b, "the same turn gives the same answer").toEqual(a);
      seen.add(a.status);
      if (a.status === "unknown") { expect(a.toldBy?.id).toBe(V); expect(a.room).toBeUndefined(); expect(a.fact).toContain("does not give a straight answer"); }
    }
    expect([...seen].sort()).toEqual(["told", "unknown"]);
  });

  it("a sheet-driven misleading: a guarded houseguest who likes the one asked about more than the player names a room they did not see, never the true one", () => {
    const { s, h, V, S } = stage();
    h.noteNpcSighting(V, S, "storage-room", true);
    sheet(h, GUARDED, { player: 0, subject: 1 }, V, S);
    const e = entry(s, S);
    expect(e.status).toBe("told");
    expect(e.room).not.toBe("storage-room");
    expect(e.room).not.toBe("bedroom-a"); // not where they really are either
    expect(e.fact).not.toMatch(/mislead|lie|false/i); // the narrator is not told it is false
  });
});
