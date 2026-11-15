import { describe, it, expect } from "vitest";
import { jurorArchetypeFor, finalHohChoice, type FinalHohOption } from "../../src/engine/juryMinds";
import { jurorProfile } from "../../src/engine/jurorProfile";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";

/** ORW-253 slice 6 core: jurors vote by who they are; the NPC Final HOH thinks about who they can beat. Roles only. */
const char = (archetype: Archetype, strategyStyle: StrategyStyle = "social"): AgendaCharacter => ({ archetype, strategyStyle, secretKinds: [] });

describe("a juror's voting style comes from their character, not a hash of their id", () => {
  it("a hothead holds grudges, a peacemaker forgives, a loyalist rewards loyalty, a comp beast rewards the game", () => {
    for (let i = 0; i < 30; i++) {
      const id = `npc:${i}`;
      expect(jurorArchetypeFor(char("hothead", "aggressive"), id, 5)).toBe("grudge-holder");
      expect(jurorArchetypeFor(char("peacemaker", "social"), id, 5)).toBe("forgiver");
      expect(jurorArchetypeFor(char("loyalist", "loyal"), id, 5)).toBe("loyalist");
      expect(jurorArchetypeFor(char("comp-beast", "strategic"), id, 5)).toBe("competitor");
    }
  });

  it("the old id hash ignored character (the defect this fixes): the same hothead got different styles by id", () => {
    const old = new Set(Array.from({ length: 30 }, (_, i) => jurorProfile(`npc:${i}`).archetype));
    expect(old.size).toBeGreaterThan(1);
  });

  it("the style shifts a close call, and the jitter only breaks near-ties", () => {
    // A flirt leans pragmatist (0.7) over forgiver (0.5); a social style (+0.3 forgiver) tips some flirts to forgiver.
    const styles = new Set(Array.from({ length: 40 }, (_, i) => jurorArchetypeFor(char("flirt", "social"), `npc:${i}`, 5)));
    expect(styles).toEqual(new Set(["pragmatist", "forgiver"]));
    expect(new Set(Array.from({ length: 40 }, (_, i) => jurorArchetypeFor(char("flirt", "under-the-radar"), `npc:${i}`, 5)))).toEqual(new Set(["pragmatist"]));
  });
});

describe("the NPC Final HOH asks who they can beat in front of the jury", () => {
  const RIVAL = "npc:2", ALLY = "npc:3";
  // Evict the rival (keep the ally): the HOH would beat the ally 70% of the jury. Evict the ally (keep the rival): only 40%.
  const options: FinalHohOption[] = [
    { evict: RIVAL, keep: ALLY, myJuryShareVsKeep: 0.3, threatOfEvict: 0.9, bondWithEvict: 0.1 },
    { evict: ALLY, keep: RIVAL, myJuryShareVsKeep: 0.75, threatOfEvict: 0.3, bondWithEvict: 0.9 },
  ];
  it("a strategist sits beside the one they can beat, even cutting an ally (the old rule evicted the bigger threat)", () => {
    expect(finalHohChoice(char("mastermind", "strategic"), options)).toEqual({ evict: ALLY, reason: "beatable-in-finale" });
  });
  it("a loyalist takes their ally to the end anyway", () => {
    expect(finalHohChoice(char("loyalist", "loyal"), options)).toEqual({ evict: RIVAL, reason: "loyal-to-ally" });
  });
  it("a hothead cuts the biggest threat", () => {
    expect(finalHohChoice(char("hothead", "aggressive"), options)).toEqual({ evict: RIVAL, reason: "biggest-threat" });
  });
  it("when the jury odds and the threat agree, everyone makes the same call", () => {
    const easy: FinalHohOption[] = [
      { evict: RIVAL, keep: ALLY, myJuryShareVsKeep: 0.8, threatOfEvict: 0.9, bondWithEvict: 0.1 },
      { evict: ALLY, keep: RIVAL, myJuryShareVsKeep: 0.2, threatOfEvict: 0.2, bondWithEvict: 0.8 },
    ];
    for (const k of ["mastermind", "loyalist", "hothead", "floater"] as Archetype[]) expect(finalHohChoice(char(k), easy).evict).toBe(RIVAL);
    expect(() => finalHohChoice(char("floater"), [])).toThrow();
  });
});
