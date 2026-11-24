import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { FRIEND_MEMORY, friendSeverity, SCENE_MEMORY_SEVERITY } from "../../src/engine/npcMemory";
import { playedGame } from "../support/playedGame";

/**
 * B25 (ORWELL_MEMORY_FRIENDS, default ON) - the treatment of friends, REAL PATH. A played season runs to its second week through the player's levers only, so every
 * houseguest-to-houseguest bond is the one the house formed by itself. Then the player records a betrayal scene with someone in their room (the player tool
 * `recordInteraction`, the same call the front end makes). The houseguests in that scene remember it at full weight; every houseguest OUTSIDE it whose strongest
 * bond to someone in it clears the closeness bar remembers it too, smaller; everyone below the bar remembers nothing new. With the flag off, the same seed and the
 * same scene reach no one outside it. Seed 11: its week-2 house has both a close tie and a distant one to the people in the player's room (checked below, not assumed).
 * Roles only.
 */
type Ledger = Record<string, Record<string, Array<{ kind: string; severity: number }>>>;
const SEED = 11;

async function betrayalScene(on: boolean) {
  const g = playedGame({ seed: SEED, user: `friends-${on}`, before: (s) => s.setMemoryFriendsEnabled(on) });
  g.playUntil(() => (g.s.getGameState() as { week?: number }).week! >= 2 && !g.s.getGameState().pending, 5000, "week 2");
  const where = g.s.whereabouts()!;
  const presence = (g.s as unknown as { presence?: Map<string, string> }).presence;
  const living = g.s.livingIds().filter((id) => id !== PLAYER);
  const inRoom = living.filter((id) => presence?.get(id) === where.room);
  const ledger = (): Ledger => ((g.s.snapshot().live as { npcMemory?: Ledger }).npcMemory ?? {});
  const before = ledger();
  const touched = inRoom[0] ?? living[0]!;
  const res = await g.sb.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, touched], content: "the player turns on them", kind: "betrayal" });
  expect((res as { eventId?: string }).eventId, "the scene was recorded").toBeTruthy();
  const holders = [touched]; // the houseguests the scene touched: the ones the player named (co-present bystanders are witnesses, not the wronged party)
  const rel = g.sb.engine.relationships;
  const best = (f: string): number => Math.max(-1, ...holders.map((h) => rel.bondStrength(f, h)));
  const outside = living.filter((f) => !holders.includes(f));
  const count = (L: Ledger, h: string): number => L[h]?.[PLAYER]?.length ?? 0;
  const after = ledger();
  const fresh = (h: string) => (after[h]?.[PLAYER] ?? []).slice(count(before, h));
  return { holders, outside, best, fresh };
}

describe("B25 REAL PATH: a betrayal the player records reaches the touched houseguests' close friends", () => {
  it("on: full weight for the people in the scene, smaller for close friends outside it, nothing below the bar", async () => {
    const t = await betrayalScene(true);
    const own = SCENE_MEMORY_SEVERITY["betrayal"]!.severity;
    expect(t.holders.length).toBeGreaterThan(0);
    for (const h of t.holders) expect(t.fresh(h).some((e) => e.kind === "scene-betrayal" && e.severity === own), "a houseguest in the scene remembers it at full weight").toBe(true);
    const close = t.outside.filter((f) => t.best(f) >= FRIEND_MEMORY.minBond);
    const far = t.outside.filter((f) => t.best(f) < FRIEND_MEMORY.minBond);
    expect(close.length, "the seed's house has a close friend outside the scene").toBeGreaterThan(0);
    expect(far.length, "and a distant houseguest").toBeGreaterThan(0);
    for (const f of close) {
      const e = t.fresh(f);
      expect(e.length, "a close friend remembers it").toBe(1);
      expect(e[0]!.kind).toBe("scene-betrayal");
      expect(e[0]!.severity).toBeCloseTo(friendSeverity(own, t.best(f)), 9);
      expect(e[0]!.severity).toBeLessThan(own);
    }
    for (const f of far) expect(t.fresh(f), "a distant houseguest remembers nothing new").toEqual([]);
  });
  it("off: the same seed and the same scene reach no one outside it", async () => {
    const t = await betrayalScene(false);
    expect(t.holders.length).toBeGreaterThan(0);
    for (const f of t.outside) expect(t.fresh(f)).toEqual([]);
  });
});
