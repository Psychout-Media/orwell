import { describe, it, expect } from "vitest";
import { chooseHourAction, ACTIONS, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import { GROUP_IDENTITY, habitBar, habitRoom, inDebriefWindow, isClosePair, pairKey, allianceNameFromHouse, noteIdentity, nicknameOf, type BondReader } from "../../src/engine/groupIdentity";
import { isPrivateRoom, type Room } from "../../src/domain/house";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { HouseCulture } from "../../src/engine/npcMindsAuthored";
import { ALLIANCE } from "../../src/engine/alliances";
import { HOUSE_LIFE } from "../../src/engine/houseLifeConstants";
import { whisperHabitSighting } from "../../src/engine/houseSuspicion";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** ORW-566 / spec 0183 parts a-b, the pure seams. Roles only: a holder, their partner, a bystander. */
const HOLDER = "npc:1", PARTNER = "npc:2", OTHER = "npc:3";
const SPOT: Room = "dining-room";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
const KEY = pairKey(HOLDER, PARTNER);
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [PARTNER, SPOT], [OTHER, "backyard"]]),
    affinity: new Map([[PARTNER, 0.8], [OTHER, 0.5]]), threat: new Map(),
    mates: [], nominees: [], timeOfDay: "evening", day: 3, hour: 19, inCompetition: false, candor: 0.7, ...over,
  };
}
const run = (v: HourView, n = 600): PlannedAction[] => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, day: 3 + Math.floor(i / 8), hour: 12 + (i % 8) }, 500 + i));
const debriefs = (ps: PlannedAction[]) => ps.filter((p) => p.kind === "debrief");
const HABIT = { with: PARTNER, room: SPOT, key: KEY };

describe("the debrief action and the pair habit", () => {
  it("a debrief folds as an ordinary bonding scene (same magnitude class), one partner", () => {
    expect(ACTIONS.debrief.fold).toBe("bonding");
    expect(ACTIONS.debrief.partners).toEqual({ min: 1, max: 1 });
  });
  it("a close pair meets at their spot when the partner is already there, at about the pull; the scene carries the pair key and the spot", () => {
    const ds = debriefs(run(hv({ pairHabits: [HABIT] })));
    const share = ds.length / 600;
    expect(share).toBeGreaterThan(HOUSE_LIFE.pairHabitPull * 0.7);
    expect(share).toBeLessThan(HOUSE_LIFE.pairHabitPull * 1.3);
    expect(ds.every((p) => p.with[0] === PARTNER && p.place === SPOT && p.habit === KEY)).toBe(true);
  });
  it("a partner who is somewhere else is never pulled in: it falls through to ordinary life (only the actor moves)", () => {
    const away = new Map<string, Room>([[HOLDER, "living-room"], [PARTNER, "kitchen"], [OTHER, "backyard"]]);
    expect(debriefs(run(hv({ pairHabits: [HABIT], whereabouts: away })))).toEqual([]);
  });
  it("without a habit the plan is byte-identical (empty and absent alike)", () => {
    const plain = run(hv()), empty = run(hv({ pairHabits: [] }));
    expect(empty).toEqual(plain);
    expect(debriefs(run(hv()))).toEqual([]);
  });
  it("the meetings dial scales how often: a meeting-heavy house keeps the habit more, a quiet one less", () => {
    const base = { gossip: 1, conflict: 1, flirting: 1, lying: 1 };
    const hi = debriefs(run(hv({ pairHabits: [HABIT], culture: { ...base, meetings: 1.35 } }))).length;
    const lo = debriefs(run(hv({ pairHabits: [HABIT], culture: { ...base, meetings: 1 / 1.35 } }))).length;
    expect(hi).toBeGreaterThan(lo);
  });
  it("never during a competition (public reactions only)", () => {
    expect(debriefs(run(hv({ pairHabits: [HABIT], inCompetition: true })))).toEqual([]);
  });
});

describe("who counts as a close pair, and when the window is open", () => {
  const bonds = (allied: boolean, mutual: number): BondReader => ({ allied: () => allied, mutual: () => mutual });
  it("allies are close; a non-allied pair is close only at a mutual bond past the habit bar; the loyalty dial lowers the bar", () => {
    expect(isClosePair(bonds(true, 0), HOLDER, PARTNER)).toBe(true);
    expect(isClosePair(bonds(false, 0.3), HOLDER, PARTNER)).toBe(false);
    const bar = habitBar();
    expect(bar).toBeCloseTo(ALLIANCE.npcAllyFloor * GROUP_IDENTITY.habitFloor, 12);
    expect(isClosePair(bonds(false, bar + 0.01), HOLDER, PARTNER)).toBe(true);
    expect(isClosePair(bonds(false, bar - 0.05), HOLDER, PARTNER)).toBe(false);
    expect(isClosePair(bonds(false, bar - 0.05), HOLDER, PARTNER, 1.3)).toBe(true);
  });
  it("the window opens when a ceremony resolves and closes after its span; no ceremony, no window", () => {
    expect(inDebriefWindow(100, undefined)).toBe(false);
    expect(inDebriefWindow(100, 100)).toBe(true);
    expect(inDebriefWindow(100 + GROUP_IDENTITY.windowHours, 100)).toBe(true);
    expect(inDebriefWindow(100 + GROUP_IDENTITY.windowHours + 1, 100)).toBe(false);
    expect(inDebriefWindow(99, 100)).toBe(false);
  });
  it("the pair's spot is a PUBLIC room, stable per pair; the house's nicknamed rooms are preferred when it has them", () => {
    for (let seed = 0; seed < 30; seed++) {
      const r = habitRoom(seed, KEY, undefined);
      expect(isPrivateRoom(r)).toBe(false);
      expect(habitRoom(seed, KEY, undefined)).toBe(r);
    }
    const culture: HouseCulture = { spots: [{ room: "backyard", nickname: "the Fishbowl" }], rituals: [] };
    for (let seed = 0; seed < 30; seed++) expect(habitRoom(seed, KEY, culture)).toBe("backyard");
    expect(nicknameOf(culture, "backyard")).toBe("the Fishbowl");
    expect(nicknameOf(culture, "kitchen")).toBeUndefined();
  });
});

describe("the identity floor: an alliance is named from the house's own authored words", () => {
  const culture: HouseCulture = { spots: [{ room: "kitchen", nickname: "the Pantry" }], rituals: [{ timeOfDay: "morning", action: "cook", name: "Waffle Sundays" }], runningJoke: "the missing sock saga continues daily" };
  const none = new Set<string>();
  it("the room it formed in, else a ritual name, else the head words of the running joke; nothing authored keeps today's name", () => {
    expect(allianceNameFromHouse(7, "k", culture, "kitchen", none)).toEqual({ name: "the Pantry", spot: "the Pantry" });
    expect(allianceNameFromHouse(7, "k", culture, "backyard", none)).toEqual({ name: "Waffle Sundays" });
    expect(allianceNameFromHouse(7, "k", { ...culture, rituals: [] }, "backyard", none)).toEqual({ name: "the missing sock" });
    expect(allianceNameFromHouse(7, "k", { spots: [], rituals: [] }, "backyard", none)).toBeUndefined();
    expect(allianceNameFromHouse(7, "k", undefined, "kitchen", none)).toBeUndefined();
  });
  it("a name already taken is skipped", () => {
    expect(allianceNameFromHouse(7, "k", culture, "kitchen", new Set(["the Pantry"]))).toEqual({ name: "Waffle Sundays" });
  });
  it("the store is write-once (monotonic): a second write never replaces the first", () => {
    const store = {};
    expect(noteIdentity(store, "k", { kind: "debrief", spot: "the Pantry", since: 5 })).toBe(true);
    expect(noteIdentity(store, "k", { kind: "debrief", spot: "elsewhere", since: 9 })).toBe(false);
    expect(store).toEqual({ k: { kind: "debrief", spot: "the Pantry", since: 5 } });
  });
});

describe("part b: a witnessed habit starts a whisper (position only, never what was said)", () => {
  const SEALED = "SEALED-0183-what-the-pair-said";
  const NPCS = [npc(1), npc(2), npc(3), npc(4)];
  const warm = (a: EntityId, b: EntityId) => (a === b ? 0 : 0.5);
  const deps = (seed: number, knowledge: InMemoryKnowledgeService) => ({
    occupancy: new Map<EntityId, Room>([[PLAYER, "hallway"], [npc(1), "dining-room"], [npc(2), "dining-room"], [npc(3), "dining-room"], [npc(4), "kitchen"]]),
    tenureOf: () => 3, npcs: NPCS, player: PLAYER, affinity: warm, nameOf: (id: EntityId) => `HG-${id}`, knowledge, rng: new SeededRandom(seed),
  });
  it("an onlooker who stood in the room holds a position fact about the pair and the spot, and it can reach the player; the scene's words never travel", () => {
    let fired = 0, reached = 0;
    for (let seed = 0; seed < 200; seed++) {
      const k = new InMemoryKnowledgeService(new InMemoryEventStore());
      const out = whisperHabitSighting(deps(seed, k), { pair: [npc(1), npc(2)], room: "dining-room", onlookers: [npc(3)] });
      if (!out) continue;
      fired++;
      expect(out.origin).toBe(npc(3));
      const held = k.knownTo(npc(3)).find((f) => f.content.includes("together after the ceremonies"));
      expect(held, "the onlooker holds it").toBeTruthy();
      for (const id of [PLAYER, ...NPCS]) for (const f of k.knownTo(id)) expect(f.content).not.toContain(SEALED);
      if (k.knownTo(PLAYER).some((f) => f.content.includes("together after the ceremonies"))) reached++;
    }
    expect(fired).toBeGreaterThan(0);
    expect(reached).toBeGreaterThan(0);
  });
  it("nobody who could have seen it (only the pair, or someone not in the house) means no whisper", () => {
    for (let seed = 0; seed < 50; seed++) {
      const k = new InMemoryKnowledgeService(new InMemoryEventStore());
      expect(whisperHabitSighting(deps(seed, k), { pair: [npc(1), npc(2)], room: "dining-room", onlookers: [npc(1), npc(9)] })).toBeUndefined();
    }
  });
});
