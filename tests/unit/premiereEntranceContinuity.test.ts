import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { MOMENT_PROMPTS } from "../../src/engine/momentPrompts";

/** ORW-148: the casting finale and the entrances-flow premiere prompt never put the player inside before the game stages their entrance. Roles only. */
beforeEach(() => { vi.stubEnv("ORWELL_PREMIERE_ENTRANCES", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("ORW-148 entrance continuity", () => {
  it("the casting prompt ends at the card and does not send the narrator into the premiere", () => {
    const p = MOMENT_PROMPTS["character-creation"]!;
    expect(p).not.toMatch(/move straight into the premiere/i);
    expect(p).toMatch(/STOP: the game stages the premiere/);
    expect(p).toMatch(/Narrate no house\s+entry/);
  });
  it("in the entrances flow the premiere prompt says the player is not inside until their own entrance", () => {
    const sb = new GameSessionRegistry().sandboxFor("ec-1");
    sb.session.setPremiereEntrancesEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const p = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    expect(p).toMatch(/ENTRANCES/);
    expect(p).not.toMatch(/has just walked through the front door/);
    expect(p).toMatch(/NOT inside/);
  });
  it("the non-entrances premiere (champagne circle, the BDD flow) is unchanged", () => {
    expect(MOMENT_PROMPTS["premiere"]).toMatch(/has just walked through the front door/);
  });
});
