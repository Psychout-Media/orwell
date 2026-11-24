import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";

// ORW-858 (716a remainder): the player's own move stated with a person ("go find her in the backyard", "take her to the bathroom", "let's go to the kitchen") is a move to the ROOM named. Roles only.
describe("ORW-858 a move stated with a person", () => {
  const moves: Array<[string, string]> = [
    ["I go find her in the backyard and ask what she thinks", "backyard"],
    ["I go find the HOH in the backyard and ask what she thinks", "backyard"],
    ["I go to the nominee in the lounge", "lounge"],
    ["I take her to the bathroom and tell her about the plan", "bathroom"],
    ["I bring the nominee into the kitchen and shut the door", "kitchen"],
    ["I lead him to the lounge", "lounge"],
    ["I walk with her to the lounge and talk", "lounge"],
    ["Let's go to the kitchen, I want to tell you something", "kitchen"],
    ["let's head to the backyard", "backyard"],
    ["Lets walk to the lounge and talk", "lounge"],
  ];
  for (const [text, to] of moves) it(`moves: ${text}`, () => expect(parsePlayerMoveIntent(text, "living-room")).toBe(to));

  const stays = [
    "maybe I go find her in the backyard and ask what she thinks",
    "I will take her to the bathroom and tell her about the plan",
    "I'll take her to the bathroom later",
    "I don't take her to the bathroom",
    "Should I take her to the bathroom?",
    "if she agrees I take her to the bathroom",
    "I might go find her in the backyard",
    "let's talk in the kitchen",
    "maybe let's go to the kitchen",
    "let's not go to the kitchen",
    "I take her to the moon",
    "I go find her somewhere",
    "I take her",
    "I find her in the backyard",
  ];
  for (const text of stays) it(`does not move: ${text}`, () => expect(parsePlayerMoveIntent(text, "living-room")).toBeNull());

  it("the plain forms are unchanged", () => {
    expect(parsePlayerMoveIntent("I go to the kitchen in a hurry", "living-room")).toBe("kitchen");
    expect(parsePlayerMoveIntent("take me to the lounge", "living-room")).toBe("lounge");
    expect(parsePlayerMoveIntent("I go to the lounge at night", "living-room")).toBe("lounge");
  });
});

describe("ORW-858 resolvePlayerMove: the engine moves the player before the narrator", () => {
  const started = (seed: number) => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed });
    ((s as unknown as { live: { champagneCircle?: string } }).live).champagneCircle = undefined;
    s.movePlayer("living-room");
    return s;
  };
  for (const [text, to] of [
    ["I go find her in the backyard and ask what she thinks", "backyard"],
    ["I take her to the bathroom and tell her about the plan", "bathroom"],
    ["Let's go to the kitchen, I want to tell you something", "kitchen"],
  ] as const) {
    it(`${text} -> ${to}`, () => {
      const s = started(31);
      const r = s.resolvePlayerMove({ text });
      expect(r.playerMove).toMatchObject({ from: "living-room", to });
      expect(s.whereabouts()!.room).toBe(to);
      expect(s.getGameState().playerMove).toMatchObject({ from: "living-room", to });
    });
  }
  it("a hedged form moves nothing and the player stays", () => {
    const s = started(32);
    expect(s.resolvePlayerMove({ text: "maybe I take her to the bathroom and tell her" }).playerMove).toBeNull();
    expect(s.whereabouts()!.room).toBe("living-room");
  });
  it("gathered for a house event: refused in fiction, not moved", () => {
    const s = started(33);
    (s as unknown as { live: { pending?: unknown } }).live.pending = { kind: "eviction-vote", by: s.snapshot().house!.player.id };
    const r = s.resolvePlayerMove({ text: "Let's go to the kitchen, I want to tell you something" });
    expect(r.playerMove).toMatchObject({ refused: true });
    expect(s.whereabouts()!.room).toBe("living-room");
  });
});
