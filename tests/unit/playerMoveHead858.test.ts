import { describe, it, expect } from "vitest";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";

// ORW-858 (716a): "I go to X and say Y" - what the player says AFTER the move must not hide the move. A hedge, a negation or an "if" in the move itself still means no move. Roles only.
describe("ORW-858 a move followed by speech is still a move", () => {
  const moves: Array<[string, string]> = [
    ["I head to the bathroom and ask him if we can talk", "bathroom"],
    ["I go to the kitchen and tell her I won't vote for her", "kitchen"],
    ["I walk to the backyard and say that I can't wait to see what happens", "backyard"],
    ["I go into the lounge, sit next to her and ask if she is okay", "lounge"],
    ["I head to the kitchen, and when she looks up I will say hello", "kitchen"],
  ];
  for (const [text, to] of moves) it(`moves: ${text}`, () => expect(parsePlayerMoveIntent(text, "living-room")).toBe(to));
  const stays = [
    "maybe I go to the kitchen and say hello",
    "I wonder if I should go to the kitchen and talk to her",
    "I might head to the backyard and ask her if she wants to talk",
    "if she is there I go to the kitchen and say hi",
    "I don't go to the bathroom and I say nothing",
    "I will go to the kitchen later and say hello",
  ];
  for (const text of stays) it(`does not move: ${text}`, () => expect(parsePlayerMoveIntent(text, "living-room")).toBeNull());
});
