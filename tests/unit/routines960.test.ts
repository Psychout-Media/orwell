import { describe, it, expect } from "vitest";
import { mergeAuthoredRoutines, routineNow } from "../../src/engine/routineLife";
import type { Routine } from "../../src/engine/routines";

/**
 * ORW-960 / bug scan B2-8. (1) Routines were written once, at a houseguest's first house-life hour, so habits the cast-authoring pass wrote later never became routines.
 * The played tests (the write-back landing mid-season, and NPC parity) are in tests/realpath/routines960.test.ts. Roles only.
 */
const floor: Routine = { slot: "evening", place: "backyard", action: "sunbathe", company: "alone", strength: 0.95, source: "floor" };
const authored: Routine = { slot: "evening", place: "kitchen", action: "cook", company: "whoever", strength: 0.3, source: "authored" };

describe("(1) authored habits that land late still become routines", () => {
  it("merged into a floor-only list: added once, the floor kept, the authored one leads at its time", () => {
    const store: Record<string, Routine[]> = { h: [floor] };
    expect(mergeAuthoredRoutines(store, "h", [authored])).toEqual([floor, authored]);
    expect(mergeAuthoredRoutines(store, "h", [authored, { ...authored, slot: "morning" }])).toHaveLength(2); // once authored, a no-op
    expect(routineNow(store.h!, "evening", false, () => 0)).toBe(authored);
    expect(routineNow([floor, { ...floor, place: "kitchen", strength: 0.4 }], "evening", false, () => 0)).toBe(floor); // one source only: the strongest, as before
  });

});
