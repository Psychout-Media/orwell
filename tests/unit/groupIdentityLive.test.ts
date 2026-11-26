import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { habitRoom, pairKey } from "../../src/engine/groupIdentity";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import type { Room } from "../../src/domain/house";
import type { HouseCulture } from "../../src/engine/npcMindsAuthored";

/** ORW-566 / spec 0183 parts a-b in a real played session. Roles only. */
type Priv = {
  live: { lastCeremonyAbsHour?: number; groupIdentity?: Record<string, unknown>; npcMindsAuthored?: { culture?: HouseCulture } };
  alliances: { add(n: string, f: string, m: string[], b: number): unknown };
  presence: Map<string, Room>;
  houseLifeStretch(e: InMemoryEventStore, ids: string[], i: number): Array<{ event: { houseLife?: { action: string; habit?: string; seenBy?: string[] }; initiator: string; witnessSet: string[] } }>;
  inGameAbsHour(): number | undefined;
  house: { npcs: Array<{ id: string }>; player: { id: string } };
};
let n = 0;
function start(seed: number, opts: { flag?: boolean; culture?: HouseCulture } = {}) {
  const sb = new GameSessionRegistry().sandboxFor(`gi566-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setGroupIdentityEnabled(opts.flag !== false);
  sb.session.noteMessage({ messageId: "m1" });
  const p = sb.session as unknown as Priv;
  if (opts.culture) (p.live.npcMindsAuthored ??= {}).culture = opts.culture;
  return { sb, s: sb.session as GameSessionAdapter, p, events: sb.engine.events as unknown as InMemoryEventStore };
}
/** Two allied NPCs, one already at their habit spot, the other elsewhere (not in the player's room); a window opened `ago` hours back. */
function stage(seed: number, ago: number | undefined, opts: { flag?: boolean; culture?: HouseCulture } = {}, g = start(seed, opts)) {
  const ids = g.p.house.npcs.map((x) => x.id);
  const [a, b] = [ids[0]!, ids[1]!];
  g.p.alliances.add("Pair", a, [a, b], 1);
  const spot = habitRoom(seed, pairKey(a, b), opts.culture);
  const playerRoom = g.p.presence.get(g.p.house.player.id);
  const away = (["kitchen", "living-room", "dining-room", "backyard", "bedroom-a", "bedroom-b"] as Room[]).find((r) => r !== spot && r !== playerRoom)!;
  for (const id of ids) g.p.presence.set(id, id === b && spot !== playerRoom ? spot : away);
  const now = g.p.inGameAbsHour();
  if (ago !== undefined && now !== undefined) g.p.live.lastCeremonyAbsHour = now - ago;
  return { ...g, a, b, spot, now };
}
// ORW-985: the window sweep stages each seed four ways; it casts the seed once, saves it, and restores it per variant. Same start as `start`, flag applied after the restore.
const castSaves = new Map<number, string>();
function startFromSave(seed: number, flag: boolean): ReturnType<typeof start> {
  const user = `gi566-sweep-${seed}`;
  if (!castSaves.has(seed)) {
    const reg = new GameSessionRegistry();
    reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
    castSaves.set(seed, JSON.stringify(reg.snapshot(user)));
  }
  const sb = new GameSessionRegistry().restore(user, JSON.parse(castSaves.get(seed)!));
  sb.session.setGroupIdentityEnabled(flag);
  sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session as GameSessionAdapter, p: sb.session as unknown as Priv, events: sb.engine.events as unknown as InMemoryEventStore };
}
const debriefsOf = (r: ReturnType<Priv["houseLifeStretch"]>) => r.filter((x) => x.event.houseLife?.action === "debrief");

describe("a close pair's habit in a played game", () => {
  it("meets at the spot in the window after a ceremony (across seeds), and not outside it, not with the flag off", () => {
    const hits = { inside: 0, outside: 0, off: 0, noCeremony: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const run = (ago: number | undefined, flag = true) => {
        const g = stage(seed, ago, { flag }, startFromSave(seed, flag));
        if (g.now === undefined) return [];
        return debriefsOf(g.p.houseLifeStretch(g.events, g.p.house.npcs.map((x) => x.id), 1));
      };
      hits.inside += run(0).length;
      hits.outside += run(50).length;
      hits.noCeremony += run(undefined).length;
      hits.off += run(0, false).length;
    }
    expect(hits.inside, "a close pair meets in the window").toBeGreaterThan(0);
    expect(hits.outside).toBe(0);
    expect(hits.noCeremony).toBe(0);
    expect(hits.off).toBe(0);
  });
});

/** A seed where the staged pair actually meets in the window, with the staged session kept for further checks. */
function firing(opts: { culture?: HouseCulture; third?: boolean } = {}) {
  for (let seed = 1; seed <= 60; seed++) {
    const g = stage(seed, 0, opts);
    if (g.now === undefined) continue;
    const ids = g.p.house.npcs.map((x) => x.id);
    const third = ids[2]!;
    if (opts.third) g.p.presence.set(third, g.spot);
    const res = g.p.houseLifeStretch(g.events, opts.third ? ids.filter((x) => x !== third) : ids, 1);
    const d = debriefsOf(res);
    if (d.length > 0) return { ...g, third, res, d, ids };
  }
  throw new Error("no seed fired");
}

describe("a pair who are not close never keep the habit", () => {
  it("no shared alliance and a cold tie: no debrief across seeds, window open", () => {
    let hits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = start(seed);
      const ids = g.p.house.npcs.map((x) => x.id);
      const spot = habitRoom(seed, pairKey(ids[0]!, ids[1]!), undefined);
      const pr = g.p.presence.get(g.p.house.player.id);
      for (const id of ids) g.p.presence.set(id, id === ids[1] && spot !== pr ? spot : "kitchen" === spot ? "backyard" : "kitchen");
      const now = g.p.inGameAbsHour();
      if (now === undefined) continue;
      g.p.live.lastCeremonyAbsHour = now;
      for (const a of ids) for (const b of ids) if (a !== b) { /* leave every tie at its seeded start: nobody is allied */ }
      hits += debriefsOf(g.p.houseLifeStretch(g.events, ids, 1)).filter((x) => x.event.houseLife?.habit === pairKey(ids[0]!, ids[1]!)).length;
    }
    expect(hits).toBe(0);
  });
});

describe("part b in a played game: a third houseguest who saw it reads the pair as close", () => {
  it("the scene lists who could see it, and their read of the pair rises over what a stranger to the scene reads", () => {
    const g = firing({ third: true });
    const ev = g.d[0]!.event;
    expect(ev.houseLife?.seenBy).toContain(g.third);
    expect(ev.houseLife?.habit).toBe(pairKey(g.a, g.b));
    const priv = g.s as unknown as { perceivedBond(h: string, a: string, b: string): number; seenBondsCache: Map<string, unknown> };
    const seen = priv.perceivedBond(g.third, g.a, g.b);
    const stranger = g.ids.find((x) => x !== g.a && x !== g.b && x !== g.third)!;
    expect(seen).toBeGreaterThan(priv.perceivedBond(stranger, g.a, g.b));
  });
});

describe("the identity floor in a played game", () => {
  it("a habit scene stores the pair's spot write-once, in the house's own word when it has one, else the plain room reference", () => {
    const plain = firing();
    const gi = plain.p.live.groupIdentity as Record<string, { kind: string; spot?: string; since: number }>;
    expect(Object.keys(gi)).toEqual([pairKey(plain.a, plain.b)]);
    expect(gi[pairKey(plain.a, plain.b)]!.kind).toBe("debrief");
    expect(gi[pairKey(plain.a, plain.b)]!.spot).toBeTruthy();
    const culture: HouseCulture = { spots: [{ room: "backyard", nickname: "the Fishbowl" }], rituals: [] };
    const named = firing({ culture });
    expect(named.spot).toBe("backyard");
    expect((named.p.live.groupIdentity as Record<string, { spot?: string }>)[pairKey(named.a, named.b)]!.spot).toBe("the Fishbowl");
    const before = JSON.stringify(named.p.live.groupIdentity);
    named.p.houseLifeStretch(named.events, named.ids, 2);
    expect(JSON.stringify(named.p.live.groupIdentity).startsWith(before.slice(0, before.length - 2))).toBe(true); // an existing entry is never rewritten
  });
  it("an alliance formed in a played game takes the house's own authored word; with no culture it keeps today's stock name (flag on or off alike)", () => {
    const name = (flag: boolean, culture?: HouseCulture) => {
      const g = start(5, { flag, ...(culture ? { culture } : {}) });
      const ids = g.p.house.npcs.map((x) => x.id);
      const priv = g.s as unknown as { houseAllianceName(t: string, f: string): string };
      g.p.presence.set(ids[0]!, "kitchen");
      return priv.houseAllianceName("Stock Name", ids[0]!);
    };
    expect(name(true)).toBe("Stock Name");
    expect(name(false, { spots: [{ room: "kitchen", nickname: "the Pantry" }], rituals: [] })).toBe("Stock Name");
    expect(name(true, { spots: [{ room: "kitchen", nickname: "the Pantry" }], rituals: [] })).toBe("the Pantry");
  });
});

describe("the wall and the flag", () => {
  it("no live surface carries a habit, a group identity, a pair key or the window stamp", async () => {
    const culture: HouseCulture = { spots: [{ room: "backyard", nickname: "the Fishbowl" }], rituals: [] };
    const g = firing({ culture, third: true });
    const key = pairKey(g.a, g.b);
    const surfaces = [
      await g.sb.mcp.player.callTool("getGameState", {}), await g.sb.mcp.player.callTool("gameStatus", {}), await g.sb.mcp.player.callTool("getMomentPrompt", {}),
      await g.sb.mcp.player.callTool("seasonRetrospective", {}), await g.sb.mcp.player.callTool("seasonRecap", {}), await g.sb.mcp.player.callTool("whereabouts", {}),
      await g.sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    expect(JSON.stringify(g.s.snapshot()), "positive control: the engine's own save DOES hold it").toContain("groupIdentity");
    const blob = JSON.stringify(surfaces);
    for (const k of ["groupIdentity", "pairHabits", "lastCeremonyAbsHour", '"habit"', key]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
  });
});

describe("the flag is a kill switch", () => {
  it("off: no window stamp, no identity store, no debrief event ever, whatever the house does over several beats", () => {
    for (const seed of [3, 11]) {
      const g = start(seed, { flag: false });
      for (let i = 0; i < 6; i++) g.s.advanceGame({});
      const x = g.s.snapshot() as unknown as { live?: Record<string, unknown>; events?: Array<{ houseLife?: { action: string; habit?: string } }> };
      expect(x.live && "lastCeremonyAbsHour" in x.live).toBe(false);
      expect(x.live && "groupIdentity" in x.live).toBe(false);
      expect((x.events ?? []).some((e) => e.houseLife?.action === "debrief" || e.houseLife?.habit)).toBe(false);
    }
  });
  it("on, a played game stays whole and finishes: the stamp is a number, the store only ever holds the engine's own keys", () => {
    for (const seed of [3, 11]) {
      const g = start(seed);
      for (let i = 0; i < 6; i++) g.s.advanceGame({});
      const live = (g.s.snapshot() as unknown as { live?: { lastCeremonyAbsHour?: number; groupIdentity?: Record<string, { kind: string }> } }).live!;
      if (live.lastCeremonyAbsHour !== undefined) expect(Number.isFinite(live.lastCeremonyAbsHour)).toBe(true);
      for (const v of Object.values(live.groupIdentity ?? {})) expect(["debrief", "alliance"]).toContain(v.kind);
    }
  });
});
