import { describe, it, expect } from "vitest";
import { gateHouseEvent, isActiveInHouse, playerOutReason } from "../../src/engine/inHouse";

/** ORW-1084/1085/1086: the one status gate, as a pure rule. The played seasons that prove it end to end are in tests/realpath/activeInHouse1084.test.ts. */
const live = { evictionOrder: ["npc:1", "npc:2", "npc:3", "player", "npc:4"], juryStart: 2 }; // npc:1, npc:2 are pre-jury; npc:3, the player and npc:4 are jurors
describe("the active-in-house gate", () => {
  it("who is in the house", () => {
    expect(isActiveInHouse(live, "npc:9")).toBe(true);
    for (const id of ["npc:1", "npc:3", "player", "npc:4"]) expect(isActiveInHouse(live, id)).toBe(false);
    expect(isActiveInHouse(null, "npc:1")).toBe(true);
  });
  it("why the player cannot act", () => {
    expect(playerOutReason(live)).toBe("evicted");
    expect(playerOutReason({ evictionOrder: [] })).toBeUndefined();
    expect(playerOutReason({ evictionOrder: [], finished: true })).toBe("season-over");
  });
  it("an event with a juror or an evictee among the house loses them; an act by one is not recorded", () => {
    expect(gateHouseEvent(live, "hoh-room", ["npc:9", "npc:4", "npc:8", "player"])).toEqual(["npc:9", "npc:8"]);
    expect(gateHouseEvent(live, "lobbying", ["npc:1", "npc:9"])).toBeNull();
    expect(gateHouseEvent(live, "deal", ["npc:9", "npc:2"])).toEqual(["npc:9"]);
    expect(gateHouseEvent(live, "bed-claim", ["npc:1", "npc:9"])).toEqual(["npc:9"]);
  });
  it("jurors with jurors (the jury house) and the player watching among them are theirs; a lone or pre-jury evictee has nowhere", () => {
    expect(gateHouseEvent(live, "conversation", ["player", "npc:3"])).toEqual(["player", "npc:3"]);
    expect(gateHouseEvent(live, "conversation", ["npc:3", "npc:4"])).toEqual(["npc:3", "npc:4"]);
    expect(gateHouseEvent(live, "betrayal", ["npc:1"])).toBeNull();
    expect(gateHouseEvent(live, "conversation", ["npc:1", "npc:3"])).toBeNull();
    expect(gateHouseEvent(live, "betrayal", ["npc:3"])).toBeNull();
  });
  it("the evictee on their own eviction night, the broadcast, the finale night and a finished season are not filtered", () => {
    expect(gateHouseEvent({ ...live, evictee: "npc:4" }, "betrayal", ["npc:4", "npc:9"])).toEqual(["npc:4", "npc:9"]);
    expect(gateHouseEvent(live, "house-event", ["npc:1", "npc:9"])).toEqual(["npc:1", "npc:9"]);
    expect(gateHouseEvent({ ...live, beat: "finale" }, "said-aloud", ["npc:9", "npc:4"])).toEqual(["npc:9", "npc:4"]);
    expect(gateHouseEvent({ ...live, finished: true }, "conversation", ["npc:1", "npc:9"])).toEqual(["npc:1", "npc:9"]);
  });
});
