import { describe, it, expect } from "vitest";
import { playSeed } from "../property/juryReachShared";

/**
 * ORW-213: a seeded season must not depend on what ran before it in the same process. Run seed 1 alone, then again after a different season (and a third time after the first two),
 * in ONE process, with the same environment: the three results must be identical. (A difference BETWEEN processes with different ORWELL_* environments - e.g. the BDD lane's pins in
 * cucumber.cjs - is a different game by design, not shared state; that is asserted separately below so it cannot be mistaken for a leak.) Roles only.
 *
 * ORW-507 hardening: the signature is the ORDERED record of public season events plus the summary (seed excluded, so "seed 2 differs" is about gameplay, not the input), and the
 * environment test varies a flag that is read per session (ORWELL_CALM_PRESENCE) and asserts the seasons actually differ. ORWELL_PREMIERE_ENTRANCES is captured once at module
 * load, so toggling it in-process is a no-op and is deliberately not used here.
 */
async function sig(seed: number): Promise<string> {
  const trace: string[] = [];
  const { seed: _in, ...summary } = await playSeed(seed, { trace });
  return JSON.stringify({ summary, trace });
}

// ORW-1043: seed 1 in the file's own environment, as the first test played it first; the second test compares against that same season (the first test
// proves it replays identically), so it is not played a fifth time. Run alone, the second test plays it itself.
let seedOneAsRun: string | undefined;

describe("same seed, same season, whatever ran before it (ORW-213)", () => {
  it("seed 1 gives the identical season alone, after another seed, and after both", async () => {
    const alone = await sig(1);
    seedOneAsRun = alone;
    const other = await sig(2);
    const after = await sig(1);
    const again = await sig(1);
    expect(JSON.parse(alone).trace.length, "the signature carries real season events").toBeGreaterThan(20);
    expect(other, "the second seed is a different season (the check is not vacuous)").not.toBe(alone);
    expect(after).toBe(alone);
    expect(again).toBe(alone);
  }, 600_000);
  it("the environment IS part of the game: a per-session flag pin plays a different season (so a cucumber-vs-alone difference is the environment, not leaked state)", async () => {
    const saved = process.env.ORWELL_CALM_PRESENCE;
    const savedGate = process.env.ORWELL_BEDTIME_GATE; // `playSeed` sets it on every call
    try {
      delete process.env.ORWELL_CALM_PRESENCE;
      const defaults = (saved === undefined ? seedOneAsRun : undefined) ?? (await sig(1)); // reused only when the first test ran under these same defaults
      process.env.ORWELL_CALM_PRESENCE = "0";
      const pinned = await sig(1);
      expect(pinned, "the pinned environment is a different season").not.toBe(defaults);
    } finally {
      if (saved === undefined) delete process.env.ORWELL_CALM_PRESENCE; else process.env.ORWELL_CALM_PRESENCE = saved;
      if (savedGate === undefined) delete process.env.ORWELL_BEDTIME_GATE; else process.env.ORWELL_BEDTIME_GATE = savedGate;
    }
  }, 600_000);
});
