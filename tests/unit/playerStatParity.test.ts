import { describe, it, expect } from "vitest";
import { ARCHETYPES, NEUTRAL_PLAYER_STATS, runPlayerOOBE, startNewGame } from "../../src/engine/characterFactory";

/**
 * ORW-868 (player parity both ways): the player's competition stats come from the same distribution as the cast's. The cast draws each houseguest's archetype from the
 * ARCHETYPES pool and jitters its bias a little; a player who authored no archetype gets the pool's mean aptitude (no invented identity), a player who authored one gets that
 * archetype's bias, exactly as a houseguest of that archetype does. Roles only.
 */
const KEYS = ["physical", "mental", "social"] as const;

describe("ORW-868: the player's stats follow the cast's distribution", () => {
  it("an unauthored player sits at the cast's mean aptitude, per stat, over many seeds (within sampling error)", () => {
    const npcSum = { physical: 0, mental: 0, social: 0 };
    let n = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const house = startNewGame({ seed, playerName: "Player" });
      for (const npc of house.npcs) { for (const k of KEYS) npcSum[k] += npc.character.stats[k]; n++; }
    }
    for (const k of KEYS) expect(Math.abs(NEUTRAL_PLAYER_STATS[k] - npcSum[k] / n), `${k}: player vs cast mean`).toBeLessThan(0.02);
    const all = (o: Record<string, number>): number => (o.physical! + o.mental! + o.social!) / 3;
    expect(all(NEUTRAL_PLAYER_STATS), "the player is not below the cast on average").toBeGreaterThan(0.55);
  });

  it("the profile is derived from the archetype pool, not a literal, and invents no archetype", () => {
    for (const k of KEYS) expect(NEUTRAL_PLAYER_STATS[k]).toBeCloseTo(ARCHETYPES.reduce((a, s) => a + s.bias[k], 0) / ARCHETYPES.length, 12);
    const p = runPlayerOOBE({ name: "Author" });
    expect(p.archetypeDefaulted).toBe(true);
    expect(p.character.stats).toEqual(NEUTRAL_PLAYER_STATS);
  });

  it("a player who authored an archetype keeps that archetype's bias, the rule a houseguest of it follows", () => {
    for (const spec of ARCHETYPES) {
      const p = runPlayerOOBE({ name: "Author", archetype: spec.archetype });
      expect(p.archetypeDefaulted).toBeFalsy();
      expect(p.character.stats).toEqual(spec.bias);
    }
  });
});
