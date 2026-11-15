import { describe, it, expect } from "vitest";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/** ORW-214: the narrator never voids a scene out of character and never stages a comp-shaped setup the game has not issued. Prompt pin (the rule is wording; the engine already owns every outcome). */
describe("ORW-214 narrator never retracts out of character", () => {
  it("the base prompt forbids out-of-character retraction and steers to in-fiction folding", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/NEVER RETRACT OUT OF CHARACTER/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/none of that's canon/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/fold it into the story/);
  });
  it("the base prompt forbids staging a competition-shaped setup the game has not issued", () => {
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/never stage a competition-shaped setup/);
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/a comp exists only when the game hands you one/);
  });
});
