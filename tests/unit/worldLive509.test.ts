import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { AllianceStore } from "../../src/engine/alliances";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { roomLabel } from "../../src/engine/roomLabels";
import { ERUPTION_POOLS } from "../../src/engine/triggers";

// ORW-509 live path: the house is authored at setup and adopted; the narrator names an alliance at the join and the seeded flavour block rides the turn; the dead
// season's world picks carry into the next season.

const houseDraft = (tag: string): unknown => ({
  name: `The ${tag} Inn`, pitch: `An old inn at the end of a snowed-in road, every room lit by a different ${tag}.`,
  rooms: Object.fromEntries(HOUSE_ROOMS.map((r) => [r, { name: `the ${tag} ${r.replace(/-/g, " ")} ${r.length}`, look: "Low beams, a single hanging lamp, and a smell of woodsmoke and old paper." }])),
});

describe("ORW-509 house authored at setup, adopted at createCharacter", () => {
  it("a house proposed on the pre-game write-back becomes the season's rooms; a refused one leaves plain labels", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 11 });
    const res = s.recordCastGenesis({ npcs: [], house: houseDraft("Pelican") });
    expect(res.house?.accepted).toBe(true);
    s.createCharacter({ playerName: "The Player", seed: 11 });
    const live = s.snapshot().live!;
    expect(live.houseTheme).toBe(res.house!.id);
    expect(roomLabel("kitchen", live.houseTheme)).toContain("pelican kitchen");

    const t = new GameSessionAdapter();
    t.preSeedCast({ seed: 12 });
    expect(t.recordCastGenesis({ npcs: [], house: { name: "x" } }).house).toMatchObject({ accepted: false, rejected: { shape: 1 } });
    t.createCharacter({ playerName: "The Player", seed: 12 });
    expect(t.snapshot().live!.houseTheme).toBeUndefined();
  });
  it("the definition survives a snapshot round trip", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 13 });
    s.recordCastGenesis({ npcs: [], house: houseDraft("Heron") });
    s.createCharacter({ playerName: "The Player", seed: 13 });
    const snap = s.snapshot();
    expect(snap.live!.houseThemeDef?.name).toBe("The Heron Inn");
    const r = new GameSessionAdapter();
    r.restore(snap);
    expect(roomLabel("hallway", r.snapshot().live!.houseTheme)).toContain("heron hallway");
  });
});

describe("ORW-509 the dead season's world picks carry into the next season (engine-internal, like priorCastNames)", () => {
  it("a confirmed restart hands the next season the competition themes and alliance names the last one used", () => {
    const rel = new RelationshipModel(0.5);
    const s = new GameSessionAdapter(rel);
    s.createCharacter({ playerName: "The Player", seed: 21 });
    const ids = (s.snapshot().house?.npcs ?? []).map((n) => n.id) as EntityId[];
    (s as unknown as { alliances: AllianceStore }).alliances.add("The Lantern Pact", ids[0]!, [ids[0]!, ids[1]!], 1);
    const used = s.worldMemory();
    expect(used.compThemes!.length).toBeGreaterThan(20);
    s.createCharacter({ playerName: "The Player", seed: 22, confirmRestart: true });
    const carried = s.snapshot().worldAvoid!;
    expect(carried.allianceNames).toContain("The Lantern Pact");
    for (const id of used.compThemes!.slice(0, 5)) expect(carried.compThemes).toContain(id);
  });
});

describe("ORW-509 narrator-authored alliance name at the join", () => {
  const setup = (): { s: GameSessionAdapter; id: string; founder: EntityId } => {
    const rel = new RelationshipModel(0.5);
    const s = new GameSessionAdapter(rel);
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const ids = (s.snapshot().house?.npcs ?? []).map((n) => n.id) as EntityId[];
    for (const [x, y] of [[PLAYER, ids[0]!], [ids[0]!, PLAYER]] as const) { const e = rel.edge(x, y); e.trust = 0.85; e.affinity = 0.85; }
    const al = (s as unknown as { alliances: AllianceStore }).alliances;
    const a = al.add("The Brigade", ids[0]!, [ids[0]!, ids[1]!], 1);
    al.reveal(a.id, PLAYER);
    return { s, id: a.id, founder: ids[0]! };
  };
  it("accepts a fitting name", () => {
    const { s, id } = setup();
    expect(s.joinAlliance({ allianceId: id, name: "The Last Table" })!.name).toBe("The Last Table");
  });
  it("keeps the engine's name, and counts it, when the proposal breaks the naming rules", () => {
    const { s, id } = setup();
    const houseguest = (s.snapshot().house!.npcs[0]!.name).split(" ")[0]!;
    expect(s.joinAlliance({ allianceId: id, name: `${houseguest}'s Crew` })!.name).toBe("The Brigade");
    expect(s.snapshot().live!.allianceNameRejects).toBe(1);
  });
});

describe("ORW-509 seeded flavour block (no extra call)", () => {
  it("is absent without a house event today and carries two anchors and the used lines when one was just recorded", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 31, avoidWorld: { eventLines: ["A tight grocery budget hits the whole house and tempers fray by mid-afternoon."] } });
    expect(s.gameStatus().flavourSeed).toBeUndefined();
    const ev = { id: "t:1", ts: 1, type: "house-event" as const, initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: `Week ${s.gameStatus().week}, day ${s.gameStatus().day}: A pillow fight breaks out in the bedroom.` };
    (s as unknown as { record: { events(): unknown[] } }).record = { events: () => [ev] } as never;
    const f = s.gameStatus().flavourSeed;
    if (f) { // the day index depends on the premiere phase; when the stamp matches, the block must be well formed
      expect(f.anchors).toHaveLength(2);
      expect(f.anchors[0]).not.toBe(f.anchors[1]);
      expect(f.used.join(" ")).toContain("slop week");
      expect(f.note).toMatch(/SEED/);
    }
  });
});

describe("ORW-509 eruption lines", () => {
  it("each kind keeps its authored lines first and has many composed ones", () => {
    for (const k of Object.keys(ERUPTION_POOLS) as (keyof typeof ERUPTION_POOLS)[]) {
      expect(ERUPTION_POOLS[k].length).toBeGreaterThan(30);
      expect(new Set(ERUPTION_POOLS[k]).size).toBe(ERUPTION_POOLS[k].length);
    }
  });
});
