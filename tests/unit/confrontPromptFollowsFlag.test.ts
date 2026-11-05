import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/**
 * AMEND 3a item 1 - `confront` always resolves landed:true with no fold while the 0094 divergence is OFF (ORWELL_GOSSIP_CONSEQUENCE, default off), but the narrator prompt told the model a
 * distorted third-hand belief "can genuinely misfire". So a false rumor read as CONFIRMED and cost nothing. The misfire wording now follows the flag (the #2021 diary-tools pattern): with the flag
 * OFF the lever is still advertised but promises no misfire; ON, the prompt is byte-identical to the base. Roles only.
 */
const MISFIRE = "can genuinely misfire";
const MISFIRED = "it misfired";
const LEVER = "confront — when the player CONFRONTS a houseguest";

afterEach(() => GameSessionAdapter.setGossipConsequenceEnabled(null));
function prompt(on: boolean): string {
  GameSessionAdapter.setGossipConsequenceEnabled(on);
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed: 3 });
  return s.getMomentPrompt({}).systemPrompt;
}

describe("the confront misfire wording follows ORWELL_GOSSIP_CONSEQUENCE", () => {
  it("flag ON: the full wording is advertised (the base prompt is unchanged)", () => {
    const p = prompt(true);
    expect(BASE_GAME_MASTER_PROMPT).toContain(MISFIRE);
    expect(p).toContain(MISFIRE);
    expect(p).toContain(MISFIRED);
    expect(p).toContain(LEVER);
  });

  it("flag OFF: the lever stays, the misfire promise is gone, and the neighbouring accuseTie bullet is intact", () => {
    const p = prompt(false);
    expect(p).toContain(LEVER);
    expect(p).not.toContain(MISFIRE);
    expect(p).not.toContain(MISFIRED);
    expect(p).toContain("accuseTie — when the player presses a suspicion");
    expect(p).toContain("you never invent the outcome");
  });
});
