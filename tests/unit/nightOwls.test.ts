import { describe, it, expect } from "vitest";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { TimeOfDay } from "../../src/engine/timeOfDay";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { GameEvent } from "../../src/domain/event";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { endHeldNight } from "../support/heldNight";

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

type Life = NonNullable<GameEvent["houseLife"]>;
async function play(user: string, seed: number, nightOwls: boolean) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  const session = reg.sandboxFor(user).session as GameSessionAdapter;
  session.setNightOwlsEnabled(nightOwls);
  let msg = 0;
  for (let i = 0; i < 400; i++) {
    await mcp.callTool("noteMessage", { messageId: `${user}-${msg++}` });
    if (i % 12 === 11) {
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown; finished?: boolean };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `no${seed}`);
      if (adv.pending) {
        const p = adv.pending; const o = (k: number) => p.options?.[k]?.id;
        await mcp.callTool("submitDecision", p.kind === "nominations" ? { kind: p.kind, choice: [o(0), o(1)] } : p.kind === "veto-decision" ? { kind: p.kind, use: false } : p.kind === "comp-intent" || p.kind === "comp-round" ? { kind: p.kind, intent: "compete" } : p.kind === "goodbye-message" ? { kind: p.kind, vote: "respectful" } : { kind: p.kind, vote: o(0) });
      }
      if (adv.finished) break;
    }
  }
  const snap = reg.snapshot(user) as SessionSnapshot;
  return { snap, life: snap.events.filter((e) => e.houseLife) as Array<GameEvent & { houseLife: Life }> };
}

describe("night owls in a played game", () => {
  it("late-night talks are hidden Vault-class events the player is not in; flag off writes none", async () => {
    const on = await play("no-on", 5, true);
    const owlEvents = on.life.filter((e) => e.houseLife.nightOwl);
    for (const e of owlEvents) {
      expect(e.hidden).toBe(true);
      expect(e.witnessSet).not.toContain(PLAYER);
    }
    const off = await play("no-off", 5, false);
    expect(off.life.filter((e) => e.houseLife.nightOwl)).toHaveLength(0);
    console.log(`NIGHT-OWL-EVENTS on=${owlEvents.length} of ${on.life.length} house-life scenes`);
    expect(owlEvents.length, "a played game has some late-night talks").toBeGreaterThan(0);
  }, 180_000);
});
