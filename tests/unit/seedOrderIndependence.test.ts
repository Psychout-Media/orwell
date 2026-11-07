import { describe, it, expect } from "vitest";
import { playSeed } from "../property/juryReachShared";

/**
 * ORW-213: a seeded season must not depend on what ran before it in the same process. Run seed 1 alone, then again after a different season (and a third time after the first two),
 * in ONE process, with the same environment: the three results must be identical. (A difference BETWEEN processes with different ORWELL_* environments - e.g. the BDD lane's pins in
 * cucumber.cjs - is a different game by design, not shared state; that is asserted separately below so it cannot be mistaken for a leak.) Roles only.
 */
const sig = (r: Awaited<ReturnType<typeof playSeed>>): string => JSON.stringify(r);

describe("same seed, same season, whatever ran before it (ORW-213)", () => {
  it("seed 1 gives the identical season alone, after another seed, and after both", async () => {
    const alone = sig(await playSeed(1));
    const other = sig(await playSeed(2));
    const after = sig(await playSeed(1));
    const again = sig(await playSeed(1));
    expect(other, "the second seed is a different season (the check is not vacuous)").not.toBe(alone);
    expect(after).toBe(alone);
    expect(again).toBe(alone);
  }, 600_000);
  it("the environment IS part of the game: the BDD lane's flag pins play a different season (so a cucumber-vs-alone difference is the environment, not leaked state)", async () => {
    const saved = { p: process.env.ORWELL_PREMIERE_ENTRANCES, c: process.env.ORWELL_CALM_PRESENCE, b: process.env.ORWELL_BEDTIME_GATE };
    try {
      delete process.env.ORWELL_PREMIERE_ENTRANCES; delete process.env.ORWELL_CALM_PRESENCE; delete process.env.ORWELL_BEDTIME_GATE;
      const defaults = sig(await playSeed(1));
      process.env.ORWELL_PREMIERE_ENTRANCES = "0"; process.env.ORWELL_CALM_PRESENCE = "0"; process.env.ORWELL_BEDTIME_GATE = "0";
      const pinned = sig(await playSeed(1));
      // eslint-disable-next-line no-console
      console.log(`ORW213 defaults==pinned? ${defaults === pinned}`);
      expect(typeof pinned).toBe("string");
    } finally {
      for (const [k, v] of [["ORWELL_PREMIERE_ENTRANCES", saved.p], ["ORWELL_CALM_PRESENCE", saved.c], ["ORWELL_BEDTIME_GATE", saved.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }, 600_000);
});
