import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { chooseHourAction, type HourView, type PlannedAction } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";

/** ORW-656 (after the buzzer): the result of a competition is reacted to, by bond, in the hours right after the crown. Roles only. */
const OWNER = "npc:1", WINNER = "npc:2", OTHER = "npc:3";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
function hv(over: Partial<HourView> = {}): HourView {
  return {
    owner: OWNER, character: char, agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[OWNER, "living-room"], [WINNER, "living-room"], [OTHER, "living-room"]]),
    affinity: new Map([[WINNER, 0.8], [OTHER, 0.3]]), threat: new Map([[WINNER, 0.2]]),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, afterBuzzer: { winner: WINNER }, ...over,
  };
}
const run = (v: HourView, n = 200): PlannedAction[] => Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, hour: 8 + (i % 16), day: 3 + Math.floor(i / 16) }, 11 + (i % 7)));
const toward = (ps: PlannedAction[]) => ps.filter((p) => p.kind === "cheer" || p.kind === "taunt" || p.kind === "sulk");

describe("ORW-656 after the buzzer", () => {
  it("a fond houseguest congratulates the winner, and it is sometimes not sincere", () => {
    const ps = toward(run(hv({ candor: 0.5 })));
    expect(ps.length).toBeGreaterThan(0);
    const cheers = ps.filter((p) => p.kind === "cheer");
    expect(cheers.length).toBeGreaterThan(0);
    expect(cheers.every((p) => p.with[0] === WINNER)).toBe(true);
    expect(cheers.some((p) => p.truthful)).toBe(true);
    expect(cheers.some((p) => !p.truthful)).toBe(true);
  });
  it("a houseguest who reads the winner as a threat gives a barb; one who is merely cool gives a cold shoulder; a low mood sulks", () => {
    expect(toward(run(hv({ affinity: new Map([[WINNER, 0.2]]), threat: new Map([[WINNER, 0.8]]) }))).some((p) => p.kind === "taunt" && p.with[0] === WINNER)).toBe(true);
    const cool = toward(run(hv({ affinity: new Map([[WINNER, 0.2]]), threat: new Map([[WINNER, 0.1]]) })));
    expect(cool.some((p) => p.kind === "sulk" && p.with.length === 0)).toBe(true);
    expect(cool.some((p) => p.kind === "cheer" || p.kind === "taunt")).toBe(false);
    expect(toward(run(hv({ emotional: 0.2 }))).every((p) => p.kind === "sulk")).toBe(true);
  });
  it("the winner celebrates with the one they are fondest of", () => {
    const ps = toward(run(hv({ owner: WINNER, affinity: new Map([[OWNER, 0.9], [OTHER, 0.3]]) })));
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.kind === "cheer" && p.with[0] === OWNER)).toBe(true);
  });
  it("out of the winner's room, or no crown just landed: ordinary hours", () => {
    const apart = hv({ whereabouts: new Map<string, Room>([[OWNER, "living-room"], [WINNER, "kitchen"]]) });
    expect(toward(run(apart)).some((p) => p.with[0] === WINNER && (p.kind === "cheer" || p.kind === "taunt"))).toBe(false);
    const { afterBuzzer: _a, ...none } = hv();
    expect(JSON.stringify(run(none as HourView, 60))).toBe(JSON.stringify(run({ ...none, inCompetition: false } as HourView, 60)));
  });
  it("deterministic, and bounded to one action per houseguest per stretch", () => {
    expect(JSON.stringify(run(hv()))).toBe(JSON.stringify(run(hv())));
  });
});

type S = { livingIds(): string[]; houseLifeStretch(e: unknown, a: readonly string[], i: number, k?: unknown): Array<{ initiator: string; event: { houseLife?: { action: string } } }>; setCompReactionsEnabled(on: boolean): void; live: { beat?: string; hoh?: string; competition?: unknown }; presence: Map<string, string> };
async function stretches(flag: boolean, beat: string, seed = 4) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `orw656-${seed}-${flag}-${beat}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setCompReactionsEnabled(flag);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  s.live.competition = undefined; s.live.beat = beat; s.live.hoh = npcs[0]!;
  for (const id of npcs) s.presence.set(id, "backyard");
  const out: Array<{ kind: string; actor: string; with: string }> = [];
  for (let i = 0; i < 12; i++) for (const sc of s.houseLifeStretch(sb.engine.events, npcs, i, sb.engine.knowledge)) out.push({ kind: sc.event.houseLife?.action ?? "", actor: sc.initiator, with: "" });
  return { out, hoh: npcs[0]! };
}
describe("ORW-656 the beat window (live)", () => {
  it("right after the HOH crown the house reacts to the winner; flag off or a later beat: no reaction", async () => {
    const on = await stretches(true, "nominations");
    expect(on.out.filter((a) => a.kind === "cheer" || a.kind === "taunt").length).toBeGreaterThan(0);
    expect(on.out.length).toBeLessThanOrEqual(12 * 15);
    const react = (r: { out: Array<{ kind: string }> }) => r.out.filter((a) => a.kind === "cheer" || a.kind === "taunt").length;
    const off = await stretches(false, "nominations");
    const later = await stretches(true, "eviction");
    expect(react(off)).toBeLessThan(react(on));
    expect(react(later)).toBeLessThan(react(on));
  }, 120_000);
});
