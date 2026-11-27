import { describe, it, expect } from "vitest";
import { routineKey } from "../../src/engine/routineLife";
import type { Routine } from "../../src/engine/routines";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-960 / bug scan B2-8, REAL PATH. (1) Routines were written once, at a houseguest's first house-life hour, so habits the cast-authoring pass wrote later never became routines:
 * BUILT STATE (headless seasons have no cast-authoring pass), the write-back called mid-season through its real method. (2) Only the player ever learned a routine; a houseguest who
 * sees someone keep one on separate days now learns it too (parity), as the same fact: a played season. Both fail on main. Roles only.
 */
describe("(1) authored habits that land late still become routines", () => {
  it("built state, through the real write-back: habits recorded mid-season become that houseguest's routines on the next hours, nothing thinned", () => {
    const g = playedGame({ seed: 3, user: "r960-a" });
    const s = g.s as unknown as { live: { routines?: Record<string, Routine[]> }; recordNpcTraits(r: { traits: Array<{ id: string; habits: string[] }> }): { accepted: number } };
    g.playUntil(() => Object.keys(s.live.routines ?? {}).length > 5, 400, "routines composed");
    const id = Object.keys(s.live.routines!).sort()[0]!;
    const before = s.live.routines![id]!.map(routineKey);
    expect(s.live.routines![id]!.every((r) => r.source === "floor"), "setup: the floor was composed first").toBe(true);
    expect(s.recordNpcTraits({ traits: [{ id, habits: ["gym-rat", "napper"] }] }).accepted).toBe(1);
    g.playUntil(() => (s.live.routines![id] ?? []).some((r) => r.source === "authored"), 400, "the authored habit in the routines");
    const after = s.live.routines![id]!;
    const added = after.filter((r) => r.source === "authored").map((r) => r.action);
    expect(added.length, "the authored habits became routines").toBeGreaterThan(0);
    expect(added.every((a) => a === "work-out" || a === "nap"), "only the habits written").toBe(true);
    expect(after.map(routineKey).slice(0, before.length)).toEqual(before);
  }, 600_000);
});

describe("(2) parity: a houseguest learns a routine the way the player does", () => {
  type Live = { npcRoutineSightings?: Record<string, Record<string, Record<string, number[]>>> };
  it("played season: an NPC who saw someone keep a routine on three separate days knows it, as the same third-person fact", () => {
    const { at } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const live = (g.s as unknown as { live: Live }).live;
      const learned = (): Array<{ onlooker: string; holder: string; key: string }> =>
        Object.entries(live.npcRoutineSightings ?? {}).flatMap(([onlooker, byHolder]) => Object.entries(byHolder).flatMap(([holder, byKey]) => Object.entries(byKey).filter(([, d]) => d.length >= 3).map(([key]) => ({ onlooker, holder, key }))));
      g.playUntil(() => learned().length > 0, 1500, "an NPC who saw a routine on three days");
      return { g, found: learned() };
    }, { from: 1, to: 8, hint: [2, 1], sandbox: (s) => `r960-${s}`, what: "an NPC who saw a routine on three days" });
    const knowledge = (at.g.sb as unknown as { engine: { knowledge: { knownTo(id: string): Array<{ factId?: string; content: string; subject?: string }> } } }).engine.knowledge;
    for (const f of at.found) {
      expect(f.onlooker).not.toBe("player");
      const fact = knowledge.knownTo(f.onlooker).find((k) => k.factId === `routine:${f.holder}:${f.key}`);
      expect(fact, "the onlooker knows the routine").toBeDefined();
      expect(fact!.content).toContain("is usually in the");
      expect(fact!.subject, "no subject: never a secret to trade or press").toBeUndefined();
    }
  }, 1_200_000);
});
