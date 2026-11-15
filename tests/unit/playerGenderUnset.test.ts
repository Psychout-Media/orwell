import { describe, it, expect } from "vitest";
import { startNewGame } from "../../src/engine/characterFactory";

// ORW-476: the engine never infers the PLAYER's gender from their name.
describe("player genderPresentation is never name-inferred", () => {
  for (const playerName of ["Sarah Lee", "Michael Brown", "Alex Kim"]) {
    it(`unset for a typical name when none stated (${playerName.split(" ")[0]!.length} chars)`, () => {
      const h = startNewGame({ seed: 7, playerName });
      expect(h.player.character.genderPresentation).toBeUndefined();
    });
  }
  it("a stated value passes through", () => {
    const h = startNewGame({ seed: 7, playerName: "Sarah Lee", genderPresentation: "nonbinary" });
    expect(h.player.character.genderPresentation).toBe("nonbinary");
  });
  it("NPC genders are unchanged by the player's name or statement", () => {
    const a = startNewGame({ seed: 7, playerName: "Sarah Lee" }).npcs.map((n) => [n.name, n.character.genderPresentation]);
    const b = startNewGame({ seed: 7, playerName: "Sarah Lee", genderPresentation: "man" }).npcs.map((n) => [n.name, n.character.genderPresentation]);
    expect(a).toEqual(b);
  });
});
