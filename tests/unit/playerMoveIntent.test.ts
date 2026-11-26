import { describe, it, expect } from "vitest";
import { parsePlayerMoveIntent, exitRoomFrom } from "../../src/engine/playerMoveIntent";
import { HOUSE_ROOMS, areAdjacent } from "../../src/domain/house";

// ORW-419 - the player's own present-tense move, read from THEIR words only. Roles only.
describe("ORW-419 parsePlayerMoveIntent", () => {
  const moves: Array<[string, string | null, string]> = [
    ["I go to the kitchen", "living-room", "kitchen"],
    ["I head to the backyard.", "kitchen", "backyard"],
    ["I walk into the hallway", "living-room", "hallway"],
    ["take me to bedroom A", "hallway", "bedroom-a"],
    ["go into the hallway", "living-room", "hallway"],
    ["Okay, I'm heading to the lounge", "hallway", "lounge"],
    ["I want to leave the backyard", "backyard", "kitchen"],
    ["leave the backyard", "backyard", "kitchen"],
    ["I leave", "bedroom-b", "hallway"],
    ["I go inside", "backyard", "kitchen"],
    ["I go outside", "kitchen", "backyard"],
    ["I go to the kitchen and grab a snack", "backyard", "kitchen"],
    ["I smile at them. I go to the storage room.", "kitchen", "storage-room"],
    ["I want to go to the HOH room", "living-room", "hoh-room"],
    ["bring me to the bathroom", "hallway", "bathroom"],
    // live (Ryne): a clear wish to go now moves this turn
    ["I'm going to go to the kitchen", "living-room", "kitchen"],
    ["I'll head to the kitchen", "living-room", "kitchen"],
    ["I'm gonna head to the kitchen", "living-room", "kitchen"],
    ["I get up and go to the kitchen", "living-room", "kitchen"],
    ["Let me go to the kitchen", "living-room", "kitchen"],
    ["Time to go to the kitchen", "living-room", "kitchen"],
    ["I excuse myself and head to the bathroom", "living-room", "bathroom"],
    ["I want to leave the room", "living-room", "kitchen"],
    ["I'm going to leave", "living-room", "kitchen"],
  ];
  for (const [text, from, to] of moves) {
    it(`moves: ${text}`, () => expect(parsePlayerMoveIntent(text, from as never)).toBe(to));
  }
  const notMoves = [
    "I'll go to the kitchen later",
    "maybe I should go to the kitchen",
    "should I go to the backyard?",
    "don't go to the kitchen",
    "I don't want to go to the hallway",
    "if I go to the kitchen she will see",
    "I go to the party",
    "I say \"let's go to the kitchen\"",
    "I go to bed",
    "I might head to the lounge",
    "Can you take me to the kitchen?",
    "I walk over to the nominee and talk",
    "I go to the moon",
  ];
  for (const text of notMoves) {
    it(`does not move: ${text}`, () => expect(parsePlayerMoveIntent(text, "living-room")).toBeNull());
  }
  it("go inside with nowhere to go in from is not a move; unknown rooms are null", () => {
    expect(parsePlayerMoveIntent("I go inside", "kitchen")).toBeNull();
    expect(parsePlayerMoveIntent("I go to the observatory", "kitchen")).toBeNull();
    expect(parsePlayerMoveIntent("leave the kitchen", "backyard")).toBeNull(); // leaving a room you are not in
  });
  it("the last move in a message wins", () => {
    expect(parsePlayerMoveIntent("I go to the kitchen. Then I head to the backyard.", "living-room")).toBe("backyard");
  });
  it("exitRoomFrom is a floor-plan neighbour for every room", () => {
    for (const r of HOUSE_ROOMS) {
      const to = exitRoomFrom(r);
      expect(to, r).not.toBeNull();
      expect(areAdjacent(r, to!)).toBe(true);
    }
    // ORW-711: the backyard is off to the side, off the kitchen and the dining room, so the way in is the kitchen; the HOH room opens onto the landing
    expect(exitRoomFrom("backyard")).toBe("kitchen");
    expect(exitRoomFrom("hoh-room")).toBe("landing");
    expect(exitRoomFrom("landing")).toBe("living-room");
  });
});
