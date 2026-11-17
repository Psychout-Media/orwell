import { describe, it, expect } from "vitest";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { TimeOfDay } from "../../src/engine/timeOfDay";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameEvent } from "../../src/domain/event";
import { PLAYER } from "../../src/domain/ids";

/** ORW-620 night owls (spec 0192): the few still awake gather and talk late; sleepers never scheme; hidden = Vault class. Roles only. */
const HOLDER = "npc:1", AWAKE_A = "npc:2", AWAKE_B = "npc:3";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [AWAKE_A, "kitchen"], [AWAKE_B, "kitchen"]]),
    affinity: new Map([[AWAKE_A, 0.7], [AWAKE_B, 0.5]]), threat: new Map(),
    mates: [], nominees: [], timeOfDay: "late-night", day: 3, hour: 26, inCompetition: false, candor: 0.7, ...over,
  };
}
const run = (v: HourView, n = 500, tod: TimeOfDay = "late-night"): PlannedAction[] =>
  Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, timeOfDay: tod, day: 3 + Math.floor(i / 8), hour: 20 + (i % 8) }, 2000 + i));
const owls = (ps: PlannedAction[]) => ps.filter((p) => p.nightOwl);

describe("night owls (ORW-620, spec 0192)", () => {
  it("flag off (no nightOwl on the view) plans exactly as before: no plan is ever a night-owl talk", () => {
    expect(owls(run(hv()))).toHaveLength(0);
  });

  it("late at night the awake few talk: a bounded share of free hours, with an awake partner, where that partner is", () => {
    const ps = run(hv({ nightOwl: { playerUp: false } }));
    const share = owls(ps).length / ps.length;
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.45); // conservative: a small bounded pull
    for (const p of owls(ps)) {
      expect(p.with.length).toBeGreaterThan(0);
      expect(p.with.every((x) => x === AWAKE_A || x === AWAKE_B)).toBe(true);
      expect(p.place).toBe("kitchen");
    }
  });

  it("the talks vary: scheming, confessing, bonding and fights all happen across the small hours, and a trio can form", () => {
    const sad = owls(run(hv({ nightOwl: { playerUp: false }, emotional: 0.3 })));
    const rub = owls(run(hv({ nightOwl: { playerUp: false }, emotional: 0.45, affinity: new Map([[AWAKE_A, 0.1], [AWAKE_B, 0.1]]) })));
    const kinds = new Set([...sad, ...rub, ...owls(run(hv({ nightOwl: { playerUp: false } })))].map((p) => p.kind));
    expect(kinds.has("homesick-talk") && kinds.has("confront") && (kinds.has("bed-talk") || kinds.has("tell-stories")), [...kinds].join(",")).toBe(true);
    const bond = owls(run(hv({ nightOwl: { playerUp: false } })));
    expect(bond.some((p) => p.with.length === 2)).toBe(true);
  });

  it("a sleeper never takes part: a houseguest not in the view is never a partner (the caller passes only the awake)", () => {
    const onlyOne = hv({ nightOwl: { playerUp: false }, whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [AWAKE_A, "kitchen"]]), affinity: new Map([[AWAKE_A, 0.7]]) });
    for (const p of owls(run(onlyOne))) expect(p.with).toEqual([AWAKE_A]);
    const alone = hv({ nightOwl: { playerUp: false }, whereabouts: new Map<string, Room>([[HOLDER, "living-room"]]), affinity: new Map() });
    expect(owls(run(alone))).toHaveLength(0);
  });

  it("the player is a candidate only when they are still up; by day nobody is a night owl; a crowded house is not a quiet night", () => {
    const withPlayer = (up: boolean) => hv({ nightOwl: { playerUp: up }, whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [PLAYER, "kitchen"]]), affinity: new Map([[PLAYER, 0.9]]) });
    expect(owls(run(withPlayer(false)))).toHaveLength(0);
    expect(owls(run(withPlayer(true))).every((p) => p.with.includes(PLAYER))).toBe(true);
    expect(owls(run(withPlayer(true))).length).toBeGreaterThan(0);
    expect(owls(run(hv({ nightOwl: { playerUp: false } }), 300, "afternoon"))).toHaveLength(0);
    const crowd = new Map<string, Room>([[HOLDER, "living-room"], ...Array.from({ length: 8 }, (_, i) => [`npc:${10 + i}`, "kitchen"] as [string, Room])]);
    expect(owls(run(hv({ nightOwl: { playerUp: false }, whereabouts: crowd, affinity: new Map() })))).toHaveLength(0);
  });

  it("is deterministic: the same hour and seed plan the same talk", () => {
    const v = hv({ nightOwl: { playerUp: false } });
    expect(chooseHourAction(v, 77)).toEqual(chooseHourAction(v, 77));
  });
});

type S = {
  livingIds(): string[];
  houseLifeStretch(events: unknown, awakeIds: readonly string[], stretchIndex: number): unknown[];
  setNightOwlsEnabled(on: boolean): void;
  live: { playerRetired?: boolean; nightDepth?: number; timeOfDay?: string; goalApproaches?: Record<string, { desire: string; goalId: string; hour: number }> };
  presence: Map<string, string>;
  rel: { edge(a: string, b: string): { affinity: number; trust: number } };
};
async function lateNight(seed: number, nightOwls: boolean, playerUp: boolean) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `night-owls-${seed}-${nightOwls}-${playerUp}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setNightOwlsEnabled(nightOwls);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  const awake = npcs.slice(0, 3); // everyone else is asleep: they are simply not in the awake set the tick passes
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "bathroom");
  for (const id of awake) { s.rel.edge(id, PLAYER).affinity = 0.95; s.rel.edge(id, PLAYER).trust = 0.8; }
  s.live.timeOfDay = "late-night";
  if (!playerUp) s.live.playerRetired = true; // the player turned in: the engine's own awake set drops them
  const before = sb.engine.events.count();
  for (let i = 0; i < 60; i++) { s.live.nightDepth = 24 + (i % 7); s.houseLifeStretch(sb.engine.events, playerUp ? [...awake, PLAYER] : awake, i); }
  const life = sb.engine.events.queryAll().slice(before).filter((e) => e.houseLife) as GameEvent[];
  return { s, awake, asleep: npcs.slice(3), life };
}

describe("night owls in a played game (live stretch, the rest of the house asleep)", () => {
  it("late-night talks are hidden events among the awake only, never the player, never a sleeper; flag off writes none", async () => {
    const on = await lateNight(5, true, false);
    const owl = on.life.filter((e) => e.houseLife!.nightOwl);
    expect(owl.length, "the awake few talk late").toBeGreaterThan(0);
    for (const e of owl) {
      expect(e.hidden).toBe(true);
      expect(e.witnessSet).not.toContain(PLAYER);
      for (const w of e.witnessSet) expect(on.awake, "a sleeper never takes part").toContain(w);
      expect(e.witnessSet.length).toBeGreaterThanOrEqual(2);
    }
    for (const e of on.life) for (const a of on.asleep) expect(e.witnessSet).not.toContain(a);
    const off = await lateNight(5, false, false);
    expect(off.life.filter((e) => e.houseLife!.nightOwl)).toHaveLength(0);
  }, 120_000);

  it("a player who stays up can be sought out through the desire clock's own path; one who has turned in never", async () => {
    const up = await lateNight(7, true, true);
    const approaches = Object.values(up.s.live.goalApproaches ?? {}).filter((a) => a.goalId === "night-owl");
    expect(approaches.length, "an awake houseguest comes to the player who is still up").toBeGreaterThan(0);
    const down = await lateNight(7, true, false);
    expect(Object.values(down.s.live.goalApproaches ?? {}).filter((a) => a.goalId === "night-owl")).toHaveLength(0);
  }, 120_000);
});
