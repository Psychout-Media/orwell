import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-1014: the act-first round owns the player's move and bed text parses. `skip` switches those two parses off; the other resolvers in the seam still run.

function started(seed: number): GameSessionAdapter {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  ((s as unknown as { live: { champagneCircle?: string } }).live).champagneCircle = undefined;
  s.movePlayer("backyard");
  return s;
}
const room = (s: GameSessionAdapter): string => s.whereabouts()!.room;

describe("ORW-1014 resolvePlayerMove skip", () => {
  it("without skip the words move the player, as before", () => {
    const s = started(31);
    expect(s.resolvePlayerMove({ text: "I go to the kitchen" }).playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
  });

  it("skip move leaves the player where they are and records no move", () => {
    const s = started(32);
    const r = s.resolvePlayerMove({ text: "I go to the kitchen", skip: ["move"] });
    expect(r.playerMove).toBeNull();
    expect(room(s)).toBe("backyard");
  });

  it("skip move also switches off the search walk", () => {
    const s = started(33);
    const r = s.resolvePlayerMove({ text: "I look for Dana", skip: ["move"] });
    expect(r.search).toBeUndefined();
    expect(room(s)).toBe("backyard");
  });

  it("an unknown skip value is ignored by the engine", () => {
    const s = started(34);
    const r = s.resolvePlayerMove({ text: "I go to the kitchen", skip: [] });
    expect(r.playerMove).toMatchObject({ from: "backyard", to: "kitchen" });
  });
});
