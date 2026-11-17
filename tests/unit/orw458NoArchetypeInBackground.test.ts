import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-458 (Kevin 2026-11-15): the archetype is a game-mechanic label and never shows as player-visible text. New casts only;
// the engine keeps the archetype on the character internally.
describe("ORW-458 the public background carries no archetype label", () => {
  for (const seed of [7, 23, 101]) {
    it(`seed ${seed}: warm cast and live season backgrounds name a job and nothing else`, () => {
      const warm = new GameSessionAdapter().preSeedCast({ seed });
      const live = new GameSessionAdapter().createCharacter({ playerName: "The Player", seed });
      for (const h of [...warm.house, ...live.house]) {
        expect(h.background ?? "", h.id).not.toMatch(/plays as|who plays/i);
        expect(h.archetype, `${h.id} carries an archetype to check against`).toBeTruthy(); // fail loudly rather than skip (review of #2788)
        // the bare label never appears either, unless it is the houseguest's real job (an "analyst" archetype and an "analyst" occupation are different words that collide)
        if (!String(h.vocation ?? "").toLowerCase().includes(String(h.archetype).toLowerCase())) expect((h.background ?? "").toLowerCase(), h.id).not.toContain(String(h.archetype).toLowerCase());
        expect(h.background, h.id).toMatch(/^an? /); // ORW-508: "an electrician", "an EMT"
      }
    });
  }
  it("the engine still holds the archetype internally", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    expect(s.snapshot().house!.npcs.every((n) => typeof n.character.archetype === "string" && n.character.archetype.length > 0)).toBe(true);
  });
});
