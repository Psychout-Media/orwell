import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { ACTIONS, chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { Agenda, AgendaCharacter, Goal } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";

/** ORW-580: built-but-unused. Competition reactions wired; four unreachable house-life actions given inputs; one dead action deleted. Roles only. */
const HOLDER = "npc:1", HOH = "npc:2", TARGET = "npc:3", FRIEND = "npc:4", VOTER = "npc:5";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
const goal = (kind: Goal["kind"], target: string | undefined): Goal => ({
  id: `${HOLDER}:${kind}:${target ?? "-"}`, owner: HOLDER, horizon: "week", kind, ...(target ? { target } : {}), why: [{ kind: "character", weight: 1 }],
  test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1,
});
const agenda = (g: Goal): Agenda => ({ owner: HOLDER, goals: [g], history: [], formedForWeek: 1 });
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [HOH, "hoh-room"], [TARGET, "kitchen"], [FRIEND, "living-room"], [VOTER, "backyard"]]),
    affinity: new Map([[FRIEND, 0.8], [VOTER, 0.6], [TARGET, 0.2], [HOH, 0.5]]), threat: new Map([[TARGET, 0.8]]),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  };
}
const kinds = (v: HourView, n = 300): Set<string> => new Set(Array.from({ length: n }, (_, i): PlannedAction => chooseHourAction({ ...v, hour: 8 + (i % 16), day: 3 + Math.floor(i / 16) }, 77 + (i % 5))).map((p) => p.kind));

describe("ORW-580 house-life actions that were never picked", () => {
  it("bargain: a nominee with only a lukewarm swing voter trades for the vote", () => {
    const v = hv({ agenda: agenda(goal("stay-safe", undefined)), nominees: [HOLDER], affinity: new Map([[FRIEND, 0.5], [VOTER, 0.5]]) });
    expect(kinds(v).has("bargain")).toBe(true);
    const cold = hv({ agenda: agenda(goal("stay-safe", undefined)), nominees: [HOLDER], affinity: new Map([[FRIEND, 0.2], [VOTER, 0.2]]) });
    expect(kinds(cold).has("bargain")).toBe(false);
    expect(kinds(cold).has("beg")).toBe(true);
  });
  it("leak: a get-them-out goal against a target spreads what the speaker holds", () => {
    expect(kinds(hv({ agenda: agenda(goal("get-them-out", TARGET)) })).has("leak")).toBe(true);
  });
  it("confirm: an alliance-standing goal confirms the plan with an ally", () => {
    expect(kinds(hv({ agenda: agenda(goal("last-alliance-standing", undefined)), mates: [FRIEND] })).has("confirm")).toBe(true);
  });
  it("keep-quiet is gone: no ActionKind, no table row, no reader", () => {
    expect(Object.keys(ACTIONS)).not.toContain("keep-quiet");
    expect(readFileSync("src/engine/houseLife.ts", "utf8")).not.toContain("keep-quiet");
  });
});

type S = { livingIds(): string[]; houseLifeStretch(e: unknown, a: readonly string[], i: number, k?: unknown): Array<{ initiator: string; event: { houseLife?: { action: string } } }>; setCompReactionsEnabled(on: boolean): void; live: { competition?: unknown }; presence: Map<string, string> };
async function stretches(flag: boolean, inComp: boolean, seed = 4) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `orw580-${seed}-${flag}-${inComp}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setCompReactionsEnabled(flag);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  const stillIn = npcs.slice(0, 3);
  if (inComp) s.live.competition = { comp: "hoh-competition", type: "endurance", field: stillIn, stillIn, round: 1, eliminated: [] };
  for (const id of npcs) s.presence.set(id, "backyard");
  const out: Array<{ kind: string; actor: string }> = [];
  for (let i = 0; i < 12; i++) for (const sc of s.houseLifeStretch(sb.engine.events, npcs, i, sb.engine.knowledge)) out.push({ kind: sc.event.houseLife?.action ?? "", actor: sc.initiator });
  return { out, stillIn, json: JSON.stringify(sb.engine.events.queryAll()) };
}
describe("ORW-580 competition reactions", () => {
  it("those not still in a running staged competition react in public; those still in do not", async () => {
    const r = await stretches(true, true);
    const react = new Set(["cheer", "taunt", "sulk"]); // a sulk is solo and leaves no event: the partnered two are what shows
    const mine = r.out.filter((a) => !r.stillIn.includes(a.actor));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => react.has(a.kind))).toBe(true);
    expect(r.out.filter((a) => r.stillIn.includes(a.actor)).every((a) => !react.has(a.kind))).toBe(true); // in the field: ordinary hours
    expect(r.out.length).toBeLessThanOrEqual(12 * 15); // one action per houseguest per stretch: bounded
  }, 120_000);
  it("flag off or no competition running: no reaction", async () => {
    for (const [f, c] of [[false, true], [true, false]] as const) {
      const r = await stretches(f, c);
      expect(r.out.some((a) => ["cheer", "taunt", "sulk"].includes(a.kind) && !r.stillIn.includes(a.actor))).toBe(false);
    }
  }, 120_000);
  it("wall: no hidden-store field rides the events", async () => {
    const r = await stretches(true, true);
    for (const w of ["decisionWhy", "statedReasons", "vault"]) expect(r.json).not.toContain(w);
  }, 120_000);
});

describe("ORW-580 decisionWhy is left: it has a reader", () => {
  it("the stated-reason path reads the why record; no new player projection reads decisionWhy", () => {
    expect(readFileSync("src/engine/liveSeason.ts", "utf8")).toMatch(/noteStatedReason\(/);
    for (const f of ["src/engine/momentPrompts.ts", "src/surfaces/tools/registry.ts"]) expect(readFileSync(f, "utf8")).not.toContain("decisionWhy");
  });
});
