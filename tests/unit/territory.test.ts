import { describe, it, expect } from "vitest";
import { bumpTenure, topRoomOf, regularsOf, sharedTopRoom, territoryNudge, describeTerritory, TERRITORY, type Tenure } from "../../src/engine/territory";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { BedsState } from "../../src/engine/beds";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { detectBlocs } from "../../src/engine/blocs";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { ALLIANCE } from "../../src/engine/alliances";

/** ORW-561 / spec 0176 (slice 10, part 2): territory. Roles only. */
const A = "npc:1", B = "npc:2", C = "npc:3", D = "npc:4";

describe("tenure and regulars are pure and monotonic", () => {
  it("bumps accrue, never shrink, and ignore a non-positive amount", () => {
    const t: Tenure = {};
    bumpTenure(t, A, "kitchen"); bumpTenure(t, A, "kitchen", 2); bumpTenure(t, A, "kitchen", -5); bumpTenure(t, A, "kitchen", NaN);
    expect(t[A]!.kitchen).toBe(3);
  });
  it("a top room needs enough hours, ignores the Diary Room and the HOH room, and ties break by room name", () => {
    const t: Tenure = {};
    for (let i = 0; i < TERRITORY.MIN_HOURS - 1; i++) bumpTenure(t, A, "kitchen");
    expect(topRoomOf(t, A)).toBeUndefined();
    bumpTenure(t, A, "kitchen");
    expect(topRoomOf(t, A)).toBe("kitchen");
    for (let i = 0; i < 20; i++) { bumpTenure(t, A, "hoh-room"); bumpTenure(t, A, "diary-room"); }
    expect(topRoomOf(t, A), "the HOH room is a court, not a hangout; the Diary Room is private").toBe("kitchen");
    expect(t[A]!["hoh-room"], "but the HOH-room time is recorded").toBe(20);
    for (let i = 0; i < 4; i++) { bumpTenure(t, B, "backyard"); bumpTenure(t, B, "kitchen"); }
    expect(topRoomOf(t, B)).toBe("backyard");
    expect(topRoomOf(undefined, A)).toBeUndefined();
  });
  it("regularsOf picks the houseguests whose top room is that room", () => {
    const t: Tenure = {};
    for (let i = 0; i < 6; i++) { bumpTenure(t, A, "kitchen"); bumpTenure(t, B, "kitchen"); bumpTenure(t, C, "backyard"); bumpTenure(t, D, "kitchen", 0.5); }
    for (let i = 0; i < 3; i++) bumpTenure(t, B, "backyard");
    expect(regularsOf(t, "kitchen")).toEqual([A, B]);
    expect(regularsOf(t, "backyard")).toEqual([C]);
    expect(regularsOf(t, "kitchen", [B, C])).toEqual([B]);
    expect(sharedTopRoom(t, A, [A, B, C, D])).toEqual([B]);
    expect(sharedTopRoom(t, D, [A, B])).toEqual([]);
    expect(describeTerritory(t)).toEqual(["the kitchen crowd"]);
    expect(JSON.stringify(describeTerritory(t))).not.toMatch(/\d/);
  });
  it("the bond nudge is symmetric, capped, and zero for a pair with neither tie", () => {
    const t: Tenure = {};
    for (let i = 0; i < 6; i++) { bumpTenure(t, A, "kitchen"); bumpTenure(t, B, "kitchen"); bumpTenure(t, C, "backyard"); }
    const beds: BedsState = { owner: { [A]: "bedroom-a#s1", [B]: "bedroom-a#s2", [C]: "bedroom-b#s1" }, claims: [] };
    expect(territoryNudge(t, beds, A, B)).toBe(TERRITORY.NUDGE_CAP);
    expect(territoryNudge(t, beds, B, A)).toBe(territoryNudge(t, beds, A, B));
    expect(territoryNudge(t, undefined, A, B)).toBe(TERRITORY.SHARED_ROOM_NUDGE);
    expect(territoryNudge(t, beds, A, C)).toBe(0);
    expect(territoryNudge(undefined, undefined, A, B)).toBe(0);
    expect(TERRITORY.ROOMMATE_NUDGE + TERRITORY.SHARED_ROOM_NUDGE).toBeGreaterThanOrEqual(TERRITORY.NUDGE_CAP);
    expect(TERRITORY.NUDGE_CAP).toBeLessThanOrEqual(0.05);
  });
  it("the alliance floors are the ones the nudge sits under (unchanged by territory)", () => {
    expect(ALLIANCE.npcAllyFloor).toBe(0.58);
    expect(ALLIANCE.joinBondFloor).toBe(0.45);
    expect(ALLIANCE.maxNpcSize).toBeGreaterThan(0);
  });
});

describe("partner choice leans toward people who share your top room", () => {
  const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
  const hv = (over: Partial<HourView> = {}): HourView => ({
    owner: A, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
    whereabouts: new Map<string, Room>([[A, "living-room"], [B, "living-room"], [C, "living-room"]]),
    affinity: new Map([[B, 0.5], [C, 0.5]]), threat: new Map(), mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  });
  const share = (v: HourView): number => {
    let n = 0, tot = 0;
    for (let i = 0; i < 1500; i++) { const p = chooseHourAction({ ...v, day: 3 + Math.floor(i / 8), hour: 8 + (i % 8) }, 100 + i); if (p.with.length) { tot++; if (p.with[0] === B) n++; } }
    return n / tot;
  };
  it("a regular is chosen more often than an equal stranger; without the set it is a coin flip; a null set is byte-identical", () => {
    const base = share(hv());
    expect(base).toBeGreaterThan(0.4); expect(base).toBeLessThan(0.6);
    const pulled = share(hv({ kindred: new Set([B]) }));
    expect(pulled).toBeGreaterThan(base + 0.05);
    expect(pulled, "mild, not a lock").toBeLessThan(0.85);
    for (let i = 0; i < 200; i++) expect(chooseHourAction(hv({ kindred: new Set() }), i)).toEqual(chooseHourAction(hv(), i));
  });
});

type Live = { tenure?: Tenure; playedGame?: boolean };
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
let n = 0;
type Stretcher = { houseLifeStretch(events: unknown, awake: readonly string[], i: number): unknown[]; livingIds(): string[] };
/** Drive the played game's hourly house life directly (what the off-screen tick calls each turn). */
function runHours(sb: { session: GameSessionAdapter; engine: { events: unknown } }, hours: number): void {
  const s = sb.session as unknown as Stretcher;
  const awake = s.livingIds().filter((i) => i !== "player");
  const lv = (sb.session as unknown as { live: { nightDepth?: number } }).live;
  for (let h = 0; h < hours; h++) { lv.nightDepth = (lv.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, h); } // the in-game hour moves on between stretches (the rolls are keyed on it)
}
const SB = new WeakMap<GameSessionAdapter, { session: GameSessionAdapter; engine: { events: unknown } }>();
function play(seed: number, opts: { flag: boolean; played: boolean; turns?: number }): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`territory561-${n++}`);
  SB.set(sb.session, sb as never);
  sb.session.setTerritoryEnabled(opts.flag);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (opts.played) { sb.session.noteMessage({ messageId: "m0" }); runHours(sb, opts.turns ?? 1); }
  sb.session.advanceGame({});
  return sb.session;
}
const snap = (s: GameSessionAdapter) => { const x = s.snapshot() as unknown as { live?: Live }; if (x.live) delete x.live.tenure; return JSON.stringify(x); };

describe("a played game's tenure", () => {
  it("accrues from house life, survives a save round-trip, and an old save without it loads", () => {
    const s = play(7, { flag: true, played: true, turns: 40 });
    const t = live(s).tenure;
    expect(t, "hours accrued").toBeTruthy();
    expect(Object.keys(t!).length).toBeGreaterThan(3);
    const sb2 = new GameSessionRegistry().sandboxFor(`territory561-rt-${n++}`);
    sb2.session.restore(JSON.parse(JSON.stringify(s.snapshot())));
    expect(live(sb2.session).tenure).toEqual(t);
    const old = JSON.parse(JSON.stringify(s.snapshot())) as { live: Live };
    delete old.live.tenure;
    const sb3 = new GameSessionRegistry().sandboxFor(`territory561-old-${n++}`);
    sb3.session.restore(old as never);
    expect(live(sb3.session).tenure).toBeUndefined();
    sb3.session.noteMessage({ messageId: "zz" });
    expect(live(sb3.session).playedGame).toBe(true);
  });
  it("ORW-614: the player's own hours accrue like a houseguest's (played game)", () => {
    const s = play(7, { flag: true, played: true, turns: 40 });
    const t = live(s).tenure!;
    const players = Object.keys(t).filter((id) => id === "player");
    expect(players.length, "the player has a tenure row").toBe(1);
    const hours = Object.values(t["player" as keyof typeof t] ?? {}).reduce((a, h) => a + (h ?? 0), 0);
    expect(hours).toBeGreaterThan(0);
    expect(t["player" as keyof typeof t]?.["diary-room"]).toBeUndefined();
  });
  it("is monotonic as the game runs", () => {
    const s = play(7, { flag: true, played: true, turns: 20 });
    const before = JSON.parse(JSON.stringify(live(s).tenure ?? {})) as Tenure;
    runHours(SB.get(s)!, 20);
    const after = live(s).tenure ?? {};
    for (const [who, rooms] of Object.entries(before)) for (const [r, h] of Object.entries(rooms)) expect(after[who]![r as Room] ?? 0).toBeGreaterThanOrEqual(h!);
  });
  it("flag off keeps no tenure; a headless game never has one", () => {
    expect(live(play(7, { flag: false, played: true, turns: 30 })).tenure).toBeUndefined();
    expect(live(play(7, { flag: true, played: false })).tenure).toBeUndefined();
  });
  it("a headless game's snapshot is byte-identical with the flag on or off", () => {
    for (const seed of [3, 11]) expect(snap(play(seed, { flag: true, played: false }))).toBe(snap(play(seed, { flag: false, played: false })));
  });
});

describe("the wall: no tenure or territory field on any outward surface", () => {
  it("projections, the moment prompt and the admin view carry none", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`territory561-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 });
    sb.session.noteMessage({ messageId: "w0" });
    runHours(sb, 30);
    expect(Object.keys(live(sb.session).tenure ?? {}).length).toBeGreaterThan(0);
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["tenure", "territory", "regulars", "kindred", "toproom"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
    expect(sb.session.seasonRetrospective()).toBeNull();
  });
});

describe("roommates form blocs more often than the house at large", () => {
  it("with bonds drawn around the bloc threshold, roommate pairs end in a shared bloc more often than other pairs, across seeds", () => {
    let roomIn = 0, roomN = 0, otherIn = 0, otherN = 0;
    for (const seed of [3, 5, 7, 11, 13, 17, 19, 23]) {
      const sb = new GameSessionRegistry().sandboxFor(`territory561-bloc-${n++}`);
      sb.session.createCharacter({ playerName: "The Player", seed });
      sb.session.noteMessage({ messageId: "b0" });
      const s = sb.session as unknown as { live: { beds?: BedsState }; rel: RelationshipModel; livingIds(): string[] };
      const beds = s.live.beds;
      expect(beds, "a played game assigns beds").toBeTruthy();
      const ids = s.livingIds().filter((i) => i !== "player");
      const rng = new SeededRandom(seed * 101);
      for (const a of ids) for (const b of ids) if (a !== b) { const e = s.rel.edge(a, b); e.trust = 0.4 + rng.next() * 0.2; e.affinity = 0.4 + rng.next() * 0.2; }
      const blocs = detectBlocs({ rel: s.rel, active: ids, tieBoost: (a, b) => territoryNudge(undefined, beds, a, b) });
      const together = (a: string, b: string): boolean => blocs.some((bl) => bl.members.includes(a) && bl.members.includes(b));
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const mates = territoryNudge(undefined, beds, ids[i]!, ids[j]!) > 0;
        if (mates) { roomN++; if (together(ids[i]!, ids[j]!)) roomIn++; } else { otherN++; if (together(ids[i]!, ids[j]!)) otherIn++; }
      }
    }
    if (process.env.TERRITORY_DEBUG) console.log("bloc rates", roomIn / roomN, otherIn / otherN, roomN, otherN);
    expect(roomN).toBeGreaterThan(20);
    expect(roomIn / roomN, "roommates share a bloc more often").toBeGreaterThan(otherIn / otherN + 0.05);
  });
});

describe("the adapter's bond nudge is wired and gated", () => {
  const nudge = (s: GameSessionAdapter, a: string, b: string): number => (s as unknown as { territoryBondNudge(a: string, b: string): number }).territoryBondNudge(a, b);
  it("roommates get a small capped nudge in a played game; flag off or headless gives exactly 0", () => {
    const on = play(7, { flag: true, played: true }), off = play(7, { flag: false, played: true }), headless = play(7, { flag: true, played: false });
    const beds = live(on) as unknown as { beds: BedsState };
    const owners = Object.keys(beds.beds.owner);
    const pair = owners.flatMap((a) => owners.filter((b) => a < b).map((b) => [a, b] as const)).find(([a, b]) => beds.beds.owner[a]!.split("#")[0] === beds.beds.owner[b]!.split("#")[0])!;
    expect(pair, "some pair shares a bedroom").toBeTruthy();
    expect(nudge(on, pair[0], pair[1])).toBeGreaterThan(0);
    expect(nudge(on, pair[0], pair[1])).toBeLessThanOrEqual(TERRITORY.NUDGE_CAP);
    expect(nudge(off, pair[0], pair[1])).toBe(0);
    expect(nudge(headless, pair[0], pair[1])).toBe(0);
  });
});
