import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-827: every test in tests/realpath plays the game as shipped. The unit-lane setup file (tests/support/premiereTestDefault.ts) pins the premiere entrances and the bedtime gate OFF for
 * ordinary unit files; this folder is left at the deploy defaults like the heavy lanes. This file fails if that ever changes. Roles only.
 */
describe("tests/realpath runs at the deploy defaults", () => {
  it("the premiere entrances and the bedtime gate are not pinned here, and a new session has both on", () => {
    expect(process.env.ORWELL_PREMIERE_ENTRANCES).toBeUndefined();
    expect(process.env.ORWELL_BEDTIME_GATE).toBeUndefined();
    const s = new GameSessionRegistry().sandboxFor("shipped-defaults").session as unknown as { premiereEntrancesEnabled: boolean; bedtimeGateEnabled: boolean };
    expect(s.premiereEntrancesEnabled).toBe(true);
    expect(s.bedtimeGateEnabled).toBe(true);
  });
});
