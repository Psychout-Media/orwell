import { describe, it, expect, vi } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import * as houseLife from "../../src/engine/houseLife";

/**
 * ORW-892 (0207 A1): "attraction is real, private and shows only in behaviour". Outside the seeded showmances it never showed: with the seed rolls (seek chance x attraction, then a second roll) a drawn person almost
 * never got a flirt or a cuddle (0 romance scenes in a played season outside the seeded pairs; only check-ins). REAL PATH: a chat-paced season is played through the player channel (nothing hand-set); the hour planner is
 * observed with a call-through spy (same arguments, same result) and every step the attraction chose for someone who is NOT in a seeded showmance is counted by kind. A flirt or a cuddle must happen, from someone the
 * house drew to someone in the room, and the player is never the target. HEAVY LANE (tests/uat/realPath*).
 */
describe("ORW-892 REAL PATH: attraction outside the seeded showmances shows as flirts and cuddles", () => {
  it("a played season has attraction-driven flirts or cuddles between pairs the house did not seed", async () => {
    const kinds: Record<string, number> = {}; let toPlayer = 0;
    const orig = houseLife.chooseHourAction;
    const spy = vi.spyOn(houseLife, "chooseHourAction").mockImplementation((v, seed) => {
      const r = orig(v, seed) as ReturnType<typeof orig> & { drawn?: boolean };
      if (r.drawn && !v.showmance) { kinds[r.kind] = (kinds[r.kind] ?? 0) + 1; if ((r.with ?? []).includes("player")) toPlayer++; }
      return r;
    });
    try { await playMixGame(3, 1800, { user: "mixdrv-3", advanceEvery: 6 }); } finally { spy.mockRestore(); }
    const romance = (kinds["flirt"] ?? 0) + (kinds["cuddle"] ?? 0);
    console.log("ATTRACTION steps by kind", JSON.stringify(kinds));
    expect(romance, "attraction produced a flirt or a cuddle outside the seeded pairs").toBeGreaterThanOrEqual(3);
    expect(toPlayer, "never a flirt aimed at the player by this step").toBe(0);
  }, 1_800_000);
});
