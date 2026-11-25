import { describe, it, expect } from "vitest";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";
import type { Room } from "../../src/domain/house";

// ORW-926 (Fable's week-2 run): "I go back inside to the living room and sit next to ..." landed the player in the kitchen, and "I go out to the hallway and stand next to ..." moved them nowhere or to the
// backyard. The bare "inside" / "outside" shortcut was read BEFORE the room the player named. A named destination is the move; "go inside" / "go outside" alone keep the door shortcut. Roles only.
describe("ORW-926 a named destination after inside/outside is the move", () => {
  const named: Array<[string, Room, Room]> = [
    ["I go back inside to the living room and sit next to a friend", "backyard", "living-room"],
    ["I go out to the hallway and stand next to a friend", "backyard", "hallway"],
    ["I go out to the living room", "kitchen", "living-room"],
    ["I go in to the bathroom", "hallway", "bathroom"],
    ["I go outside to the backyard and sit by the fire", "living-room", "backyard"],
    ["I go back in to the kitchen and make coffee", "backyard", "kitchen"],
  ];
  for (const [text, from, to] of named) it(`${from}: ${text}`, () => expect(parsePlayerMoveIntent(text, from)).toBe(to));
  const door: Array<[string, Room, Room | null]> = [
    ["I go inside", "backyard", "kitchen"],
    ["I go back inside", "backyard", "kitchen"],
    ["I go outside", "kitchen", "backyard"],
    ["I go inside", "kitchen", null],
  ];
  for (const [text, from, to] of door) it(`no destination keeps the door shortcut: ${from}: ${text}`, () => expect(parsePlayerMoveIntent(text, from)).toBe(to));
});
