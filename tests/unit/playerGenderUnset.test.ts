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

// ORW-476 (owner ruling: ask, never assume): the intake ASKS for gender/pronouns until answered or skipped.
import { castingStatusOf, emptyIntake, mergeCastingUpdate } from "../../src/engine/castingIntake";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

const base = { castPhoto: "uploaded", playerName: "the player", backstory: "b", motivation: "m", personaArchetype: "pa", personaStrategyStyle: "ps", privateStrategy: "x", interviewNotes: ["n"], archetype: "social-butterfly", strategyStyle: "social" };

describe("casting asks for gender/pronouns (ORW-476)", () => {
  it("is asked (missing + next) until answered", () => {
    const st = castingStatusOf(mergeCastingUpdate(emptyIntake(), base as never));
    expect(st.missing).toContain("genderPresentation");
    expect(st.next).toMatch(/ASK them/);
    expect(st.next).toMatch(/skipped/);
  });
  it("a stated answer is stored and stops the ask", () => {
    const st = castingStatusOf(mergeCastingUpdate(emptyIntake(), { ...base, genderPresentation: "nonbinary" } as never));
    expect(st.known["genderPresentation"]).toBe("nonbinary");
    expect(st.missing).not.toContain("genderPresentation");
  });
  it("a skip (any phrasing) satisfies the ask: no loop, never blocks", () => {
    for (const v of ["skipped", "prefer not to say", "Skip", "rather not"]) {
      const st = castingStatusOf(mergeCastingUpdate(emptyIntake(), { ...base, genderPresentation: v } as never));
      expect(st.missing).not.toContain("genderPresentation");
      expect(st.known["genderPresentation"]).toBe("skipped");
      expect(st.finalizable).toBe(true);
    }
  });
  it("a skip leaves the player's gender unset after finalize", () => {
    const s = new GameSessionAdapter();
    s.updateCasting({ ...base, genderPresentation: "skipped" } as never);
    const view = s.createCharacter({ playerName: "Sarah Lee", seed: 3 } as never);
    expect(view.player?.genderPresentation).toBeUndefined();
  });
});
