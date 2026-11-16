import { describe, it, expect } from "vitest";
import { BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";

/** ORW-510: example lines and closed menus the writer copies were replaced by rules. The text below was quoted in the prompts before; it must not come back. */
const ALL = [BASE_GAME_MASTER_PROMPT, ...Object.values(MOMENT_PROMPTS)].join("\n");
describe("prompt examples the model copied are rules now", () => {
  it.each([
    "what do you think of Jordan", "scouting the territory", "best TV pilot", "we should call ourselves", "locked in\"",
    "'warm and open'", "a cooler greeting", "you owe me a vote", "you two knew each other before this", "keep me safe or this gets out",
    "slip into the lounge a bit ago", "day in review", "feels like...", "can't shake the sense", "who wants to see my HOH room", "It's day 12; Maya is HOH", "not something you can reach from in here", "I head to the kitchen", "bedroom a\" and",
  ])("no longer quotes %s", (s) => {
    expect(ALL).not.toContain(s);
  });
  it("still carries the rules that replaced them", () => {
    expect(ALL).toMatch(/invent fresh from this houseguest's own persona/);
    expect(ALL).toMatch(/phrased in a fresh way each time/);
  });
});
