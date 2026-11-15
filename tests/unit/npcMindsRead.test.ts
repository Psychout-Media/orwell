import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { GameEvent } from "../../src/domain/event";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { endHeldNight } from "../support/heldNight";
import { seasonLeanOf, seedAgenda, type AgendaBoard, type AgendaView, type AgendaCharacter } from "../../src/engine/agenda";
import { AIM_HINT_BONUS } from "../../src/engine/agendaConstants";
import { AUTHORED } from "../../src/engine/npcMindsAuthored";
import { HOUSE_LIFE } from "../../src/engine/houseLifeConstants";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { Room } from "../../src/domain/house";
import type { Archetype } from "../../src/engine/characterFactory";

/**
 * ORW-337 (spec 0146 lanes 1-2, Ryne 2026-11-12 "yes to house culture"; the design reads each backstory into goals): the model's cast-time words are READ.
 * The aim hint adds AIM_HINT_BONUS to that aim's lean (shapes, never forces); a house ritual pulls anyone free into its action at its time of day and the
 * scene carries its name. Roles only.
 */
const HOLDER = "npc:1", PEER = "npc:2", HOUSE = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5", "npc:6", "npc:7", "player"];
const char = (archetype: Archetype, extra: Partial<AgendaCharacter> = {}): AgendaCharacter => ({ archetype, strategyStyle: "social", secretKinds: [], ...extra });
const view = (character: AgendaCharacter, owner: string): AgendaView => ({ owner, character, threats: [], affinity: [], grudges: [], emotional: 0.5, allianceMates: [], secretExposed: false, openQuestions: [], answered: [], powerWins: 0 });
const board = (): AgendaBoard => ({ day: 2, week: 1, inHouse: HOUSE, evicted: [], juryStarted: false, finalFive: false, nominees: [], weekClosed: false });
const aimOf = (c: AgendaCharacter, owner: string, seed: number): string => seedAgenda(view(c, owner), board(), seed).goals.find((g) => g.horizon === "season")!.kind;

describe("the backstory aim hint shapes a season goal (lane 1)", () => {
  it("the bonus is one number everywhere, and it adds exactly that to the hinted aim's lean and nothing else", () => {
    expect(AUTHORED.aimHintBonus).toBe(AIM_HINT_BONUS);
    const plain = seasonLeanOf(char("floater"));
    const hinted = seasonLeanOf(char("floater", { aimHint: "run-the-house" }));
    expect(hinted["run-the-house"]).toBeCloseTo((plain["run-the-house"] ?? 0) + AIM_HINT_BONUS, 10);
    for (const k of Object.keys(plain) as Array<keyof typeof plain>) if (k !== "run-the-house") expect(hinted[k]).toBe(plain[k]);
  });

  it("a houseguest whose hint is reach-jury starts with that aim more often than a control, across seeds, and it never forces it", () => {
    const owners = Array.from({ length: 300 }, (_, i) => ({ owner: `npc:${i + 10}`, seed: 1000 + i }));
    // archetypes whose own lean is within reach of reach-jury (a far-off lean like a comp-beast's is not moved by a 0.4 hint: it shapes, never forces)
    for (const archetype of ["analyst", "underdog", "wildcard"] as Archetype[]) {
      const control = owners.filter((o) => aimOf(char(archetype), o.owner, o.seed) === "reach-jury").length;
      const hinted = owners.filter((o) => aimOf(char(archetype, { aimHint: "reach-jury" }), o.owner, o.seed) === "reach-jury").length;
      expect(hinted, `${archetype}: control ${control}, hinted ${hinted}`).toBeGreaterThan(control);
      expect(hinted, `${archetype}: a hint shapes, it never forces`).toBeLessThan(owners.length);
    }
  });
});

describe("a house ritual pulls anyone free into its action, and the scene carries its name (lane 2)", () => {
  const ROOMS = new Map<string, Room>([[HOLDER, "living-room"], [PEER, "living-room"], ["npc:3", "kitchen"], ["npc:4", "kitchen"], [PLAYER, "kitchen"]]);
  const hv = (over: Partial<HourView> = {}): HourView => ({
    owner: HOLDER, character: char("analyst"), agenda: undefined, habits: [], emotional: 0.5, room: "living-room", whereabouts: ROOMS,
    affinity: new Map([[PEER, 0.8], ["npc:3", 0.5], ["npc:4", 0.5], [PLAYER, 0.5]]), threat: new Map(), mates: [], nominees: [],
    timeOfDay: "evening", day: 3, hour: 19, inCompetition: false, candor: 0.7, ...over,
  });
  const run = (v: HourView, n = 120): PlannedAction[] => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, hour: 17 + (i % 6), day: 3 + Math.floor(i / 6) }, 77));

  it("an evening cook ritual shows up as cook scenes far more than without it, with the ritual's name on them", () => {
    expect(AUTHORED.ritualPull).toBe(HOUSE_LIFE.ritualPull);
    const ritual = { timeOfDay: "evening" as const, action: "cook" as const, name: "Family Dinner" };
    const withIt = run(hv({ rituals: [ritual] }));
    const without = run(hv());
    const cooksWith = withIt.filter((p) => p.kind === "cook").length, cooksWithout = without.filter((p) => p.kind === "cook").length;
    expect(cooksWith, `with ${cooksWith}, without ${cooksWithout}`).toBeGreaterThan(cooksWithout + 15);
    expect(withIt.filter((p) => p.ritual === "Family Dinner").every((p) => p.kind === "cook")).toBe(true);
    expect(withIt.some((p) => p.ritual === "Family Dinner")).toBe(true);
    expect(without.some((p) => p.ritual !== undefined)).toBe(false);
  });

  it("only at its time of day", () => {
    const ritual = { timeOfDay: "evening" as const, action: "cook" as const, name: "Family Dinner" };
    expect(run(hv({ rituals: [ritual], timeOfDay: "afternoon" })).some((p) => p.ritual !== undefined)).toBe(false);
  });
});

type Life = NonNullable<GameEvent["houseLife"]>;
async function playGame(user: string, culture: boolean) {
  const seed = 3;
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const session = reg.sandboxFor(user).session as GameSessionAdapter;
  if (culture) await mcp.callTool("recordHouseCulture", { rituals: [{ timeOfDay: "evening", action: "cook", name: "Family Dinner" }, { timeOfDay: "morning", action: "cook", name: "Pancake Hour" }] });
  for (let i = 0; i < 240; i++) {
    await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
    if (i % 12 === 11) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown; finished?: boolean };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `rit${seed}`);
      if (adv.pending) {
        const o = (k: number) => adv.pending!.options?.[k]?.id;
        const k = adv.pending.kind;
        await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) });
      }
      if (adv.finished) break;
    }
  }
  const snap = reg.snapshot(user) as SessionSnapshot;
  return { session, life: snap.events.filter((e) => e.houseLife) as Array<GameEvent & { houseLife: Life }> };
}

describe("in a played game (the adapter wiring)", () => {
  it("a stored ritual makes cook scenes happen with its name on the scene; a game without one has none", async () => {
    const withCulture = await playGame("rit-a", true);
    const control = await playGame("rit-b", false);
    const named = withCulture.life.filter((e) => e.houseLife.ritual);
    expect(named.length, "ritual scenes happened").toBeGreaterThan(0);
    expect(named.every((e) => e.houseLife.action === "cook" && ["Family Dinner", "Pancake Hour"].includes(e.houseLife.ritual!))).toBe(true);
    expect(control.life.some((e) => e.houseLife.ritual)).toBe(false);
    const cooks = (l: typeof withCulture.life) => l.filter((e) => e.houseLife.action === "cook").length;
    expect(cooks(withCulture.life)).toBeGreaterThan(cooks(control.life));
  }, 180_000);

  it("the aim hint reaches the agenda character at call time; a write-back that lands later leaves the seeded agenda untouched", async () => {
    const reg = composeRuntime({ clock: new FakeClock(), seed: 5 }).registry;
    const user = "hint-a";
    const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5, archetype: "floater" });
    await mcp.callTool("noteMessage", { messageId: "first" }); // a played game: agendas seed
    const s = reg.sandboxFor(user).session as GameSessionAdapter;
    const id = s.livingIds().find((x) => x !== PLAYER)!;
    expect(s.agendaCharacterOf(id)!.aimHint).toBeUndefined();
    const agendaBefore = JSON.stringify((s.snapshot().live as { agendas?: Record<string, unknown> }).agendas?.[id]);
    expect(agendaBefore).toBeDefined();
    await mcp.callTool("recordNpcTraits", { traits: [{ id, habits: ["gym-rat", "napper"], aimHint: "run-the-house", aimWhy: "a backstory aim" }] });
    expect(s.agendaCharacterOf(id)!.aimHint).toBe("run-the-house");
    expect(JSON.stringify((s.snapshot().live as { agendas?: Record<string, unknown> }).agendas?.[id])).toBe(agendaBefore);
  });
});
