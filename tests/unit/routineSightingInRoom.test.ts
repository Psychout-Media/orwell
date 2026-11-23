import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { endHeldNight } from "../support/heldNight";
import { agendaRoll } from "../../src/engine/agenda";
import { isStressed, routineKey, routineNow } from "../../src/engine/routineLife";
import type { Routine } from "../../src/engine/routines";

/**
 * ORW-799 - a houseguest who is already in the player's room when their routine pulls is seen keeping it. Before, only a routine that WALKED someone into the player's room counted (everyone in the player's room is left
 * out of the walking plans). Real path: a played game driven by messages and moveTo; nothing set by hand. The stretch is wrapped only to READ what was true at its start (who was in the player's room, which routine pulled
 * by the same keyed roll the planner uses), then every such pair must be in the player's sightings for that day. Roles only.
 */
type Live = { dayNumber?: number; week: number; timeOfDay?: string; playedGame?: boolean; nominees?: string[]; lifeHour?: { at: number; n: number }; routines?: Record<string, Routine[]>; routineSightings?: Record<string, Record<string, number[]>> };
type S = {
  live: Live; presence: Map<string, string>; gameSeed?: number;
  house: { player: { id: string } };
  houseLifeStretch(...a: unknown[]): unknown;
  awakeNow(): Set<string> | undefined; inGameHour(): number | undefined; inGameAbsHour(): number | undefined;
  soulObj(id: string): { emotionalState?: number } | undefined;
};

describe("a routine kept in front of the player is counted (played game)", () => {
  it("every houseguest in the player's room whose routine pulls this hour has a sighting that day", async () => {
    const seed = 3;
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const mcp = reg.resolver()("player", "orw799");
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    await mcp.callTool("noteMessage", { messageId: "first" });
    const s = reg.sandboxFor("orw799").session as unknown as S;
    const expected: Array<{ id: string; key: string; day: number }> = [];
    const orig = s.houseLifeStretch.bind(s);
    s.houseLifeStretch = (...a: unknown[]) => {
      const live = s.live, me = s.house.player.id, room = s.presence.get(me);
      if (live.playedGame && room && room !== "diary-room" && (s.awakeNow()?.has(me) ?? true)) {
        const day = live.dayNumber ?? live.week, hour = s.inGameHour() ?? (a[2] as number);
        const abs = s.inGameAbsHour();
        const rep = abs !== undefined && live.lifeHour?.at === abs ? live.lifeHour.n + 1 : 0;
        const hk = `d${day}h${hour}${rep ? `r${rep}` : ""}`;
        for (const [id, at] of s.presence) {
          if (id === me || at !== room) continue;
          if (!(s.awakeNow()?.has(id) ?? true)) continue;
          const rs = live.routines?.[id];
          if (!rs) continue;
          const r = routineNow(rs, (live.timeOfDay ?? "afternoon") as never, isStressed(s.soulObj(id)?.emotionalState ?? 0.5, (live.nominees ?? []).includes(id)), (k) => agendaRoll(seed, id, `hour:${hk}:routine:${k}`));
          if (r && r.action !== "nap" && r.place === room) expected.push({ id, key: routineKey(r), day });
        }
      }
      return orig(...a);
    };
    const rooms = ["kitchen", "living room", "backyard"];
    for (let i = 0; i < 400; i++) {
      { // the player goes where the house usually is at this time of day (the most common routine place now)
        const tally = new Map<string, number>();
        for (const rs of Object.values(s.live.routines ?? {})) for (const r of rs) if (r.slot === (s.live.timeOfDay ?? "afternoon") && r.action !== "nap") tally.set(r.place, (tally.get(r.place) ?? 0) + 1);
        const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
        await mcp.callTool("moveTo", { room: (best ?? rooms[i % rooms.length]!).replace(/-/g, " ") });
      }
      await mcp.callTool("noteMessage", { messageId: `m${i}` });
      if (i % 4 !== 3) continue;
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), "r799", undefined, { stopWhenDue: true });
      if (adv.pending) {
        const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        if (k === "ceremony-step") await mcp.callTool("advanceGame", {});
        else {
          try {
            await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) });
          } catch { await mcp.callTool("advanceGame", {}); }
        }
      }
    }
    expect(expected.length).toBeGreaterThan(0);
    for (const e of expected) expect(s.live.routineSightings?.[e.id]?.[e.key] ?? [], `${e.id} ${e.key}`).toContain(e.day);
  }, 600_000);
});
