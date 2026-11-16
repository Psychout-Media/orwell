import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-476: a running season takes one thing from updateCasting: `unset` clears the player's recorded gender; nothing sets one. */
const make = (g?: "woman") => {
  const s = new GameSessionAdapter();
  if (g) s.updateCasting({ genderPresentation: g });
  s.createCharacter({ playerName: "The Player", backstory: "a life", motivation: "to win", personaArchetype: "persona-role-fixture" });
  return s;
};
const line = (s: GameSessionAdapter) => s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("You are playing as:"))!;

describe("ORW-476 healing a saved player gender", () => {
  it("unset clears it: the player card and the narrator line go back to unstated", () => {
    const s = make("woman");
    expect(s.getGameState().player!.genderPresentation).toBe("woman");
    s.updateCasting({ genderPresentation: "unset" } as never);
    expect(s.getGameState().player!.genderPresentation).toBeUndefined();
    expect(line(s)).toContain("gender is unstated");
  });
  it("it cannot SET one after casting, and `unset` on an unset player changes nothing", () => {
    const s = make();
    s.updateCasting({ genderPresentation: "woman" });
    expect(s.getGameState().player!.genderPresentation).toBeUndefined();
    s.updateCasting({ genderPresentation: "unset" } as never);
    expect(s.getGameState().player!.genderPresentation).toBeUndefined();
  });
  it("the clear survives a save and restore", () => {
    const s = make("woman");
    s.updateCasting({ genderPresentation: "unset" } as never);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const t = new GameSessionAdapter();
    (t as unknown as { restore(x: unknown): void }).restore(snap);
    expect(t.getGameState().player!.genderPresentation).toBeUndefined();
  });
});
