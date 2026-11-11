import { describe, it, expect } from "vitest";
import { BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";

/**
 * ORW-284 (BDD card 33): three narrator prompt lines carried a rule nothing tested. Each is pinned as the exact line so dropping or rewording it fails here. Roles only.
 *  - N-8: at an eviction the HOH votes ONLY to break a tie, and the narrator must never say the HOH already voted (the vote is a secret ballot; the engine decides it).
 *  - N-11: the cast count is stated once ("sixteen = the player + fifteen others") and no other count is given in the casting interview.
 *  - the player is always addressed as "you" (the game stays second person, Ryne 2026-11-10), never "the player" or a third-person reference.
 */
describe("narrator prompt lines that carry a rule (ORW-284)", () => {
  it("N-8: the eviction moment says the HOH votes ONLY to break a tie and never to say the HOH already voted", () => {
    expect(MOMENT_PROMPTS.eviction).toContain("(the HOH votes ONLY to break a tie — never say the HOH already voted)");
  });

  it("N-11: the casting interview states the cast as sixteen = the player + fifteen others, and no other count", () => {
    expect(MOMENT_PROMPTS["character-creation"]).toContain("(Cast: sixteen — the player + fifteen others; state no other count.)");
  });

  it('the player is always addressed as "you", never "the player" or any third-person reference', () => {
    expect(BASE_GAME_MASTER_PROMPT).toContain('Always address the player as "you" — never "the player" or any third-person reference to them.');
  });

  it("the three lines are in the prompts the narrator is actually handed, once each", () => {
    const count = (hay: string, needle: string) => hay.split(needle).length - 1;
    expect(count(MOMENT_PROMPTS.eviction ?? "", "the HOH votes ONLY to break a tie")).toBe(1);
    expect(count(MOMENT_PROMPTS["character-creation"] ?? "", "state no other count")).toBe(1);
    expect(count(BASE_GAME_MASTER_PROMPT, 'Always address the player as "you"')).toBe(1);
  });
});
