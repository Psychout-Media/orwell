import { describe, it, expect } from "vitest";
import { decidePlantToPlayer, plantChance, PLANT_TO_PLAYER, toldTodayBy } from "../../src/engine/plantToPlayer";

const scene = { holder: "a", candidates: ["t"], cunning: 0.5, candor: 0.5, audience: 0, toldToday: false, roll: 0, pick: 0 };

describe("plantToPlayer (0159)", () => {
  it("needs a target, a draw under the chance, and no telling today", () => {
    expect(decidePlantToPlayer(scene)).toEqual({ about: "t" });
    expect(decidePlantToPlayer({ ...scene, candidates: [] })).toBeUndefined();
    expect(decidePlantToPlayer({ ...scene, toldToday: true })).toBeUndefined();
    expect(decidePlantToPlayer({ ...scene, roll: 0.99 })).toBeUndefined();
    expect(decidePlantToPlayer({ ...scene, candidates: ["a"] })).toBeUndefined();
  });
  it("is rare, rises with cunning, falls with candor and a crowd, and is zero in a big one", () => {
    expect(plantChance({ cunning: 1, candor: 0, audience: 0 })).toBeLessThan(0.06);
    expect(plantChance({ cunning: 1, candor: 0.5, audience: 0 })).toBeGreaterThan(plantChance({ cunning: 0, candor: 0.5, audience: 0 }));
    expect(plantChance({ cunning: 0.5, candor: 1, audience: 0 })).toBeLessThan(plantChance({ cunning: 0.5, candor: 0, audience: 0 }));
    expect(plantChance({ cunning: 0.5, candor: 0.5, audience: 2 })).toBeLessThan(plantChance({ cunning: 0.5, candor: 0.5, audience: 0 }));
    expect(plantChance({ cunning: 1, candor: 0, audience: PLANT_TO_PLAYER.crowdMax + 1 })).toBe(0);
  });
  it("picks among targets deterministically", () => {
    const s = { ...scene, candidates: ["z", "m", "b"] };
    expect(decidePlantToPlayer({ ...s, pick: 0 })).toEqual({ about: "b" });
    expect(decidePlantToPlayer({ ...s, pick: 0.99 })).toEqual({ about: "z" });
  });
  it("reads a claim with no day as day 0", () => {
    expect(toldTodayBy([{ week: 1 }], 1, 0)).toBe(true);
    expect(toldTodayBy([{ week: 1, day: 2 }], 1, 3)).toBe(false);
    expect(toldTodayBy([{ week: 1, day: 2 }], 2, 2)).toBe(false);
  });
});
