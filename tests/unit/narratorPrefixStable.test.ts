import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/**
 * ORW-266 / ADR 0010 slice C (cache-friendly order): the narrator system prompt keeps its STABLE part first and byte-identical from one turn to the next, so a provider's prefix cache can hit; everything that
 * changes per turn (the moment, the game context) comes after. Engine side of the contract (the FE appends its per-turn steers after this). No model, roles only.
 */
const stableLen = (p: string): number => p.indexOf("\n\nMOMENT");

describe("the narrator prompt's stable prefix", () => {
  it("is byte-identical across consecutive turns, and the volatile moment comes after it", () => {
    const s = new GameSessionRegistry().sandboxFor("prefix").session;
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    const prompts: string[] = [s.getMomentPrompt({}).systemPrompt];
    for (let i = 0; i < 6; i++) { s.advanceGame(); prompts.push(s.getMomentPrompt({}).systemPrompt); }
    const n = stableLen(prompts[0]!);
    expect(n, "the stable base is large and precedes the first MOMENT marker").toBeGreaterThan(10000);
    for (const p of prompts) {
      expect(p.slice(0, n)).toBe(prompts[0]!.slice(0, n));
      expect(p.startsWith(BASE_GAME_MASTER_PROMPT.slice(0, 3000)), "the static base leads; nothing volatile is placed ahead of it").toBe(true);
    }
    expect(new Set(prompts).size, "the volatile tail does change between turns").toBeGreaterThan(1);
  });
  it("carries the hard-stop rules in that stable part (tiering or trimming downstream can never be what keeps them)", () => {
    const s = new GameSessionRegistry().sandboxFor("prefix2").session;
    s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    const p = s.getMomentPrompt({}).systemPrompt;
    const head = p.slice(0, stableLen(p));
    expect(head).toMatch(/NEVER|never/);
    expect(head.length).toBeGreaterThan(p.length / 2);
  });
});
