import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-382 (Ryne, live playtest 11-15: no "day in review" when he went to bed on Day 1): the premiere night has no ceremony or deal, so the recap carried NOTHING and the narrator rightly skipped it.
 * The review is now also built from the scenes the player WITNESSED (never a hidden event). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-382 - every bedtime has a day in review, the premiere night included", () => {
  it("day 1 bed after the premiere: the recap names what the player saw", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("recap-premiere").session as any;
    s.setPremiereEntrancesEnabled(true); // the deployed premiere (the unit lane defaults it off)
    s.createCharacter({ playerName: "P", seed: 5 });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
    const v = s.turnIn();
    expect(v.held).toBeUndefined();
    expect(v.dailyRecap?.day).toBe(1);
    expect(v.dailyRecap?.highlights).toEqual([]); // no ceremony or deal on the premiere
    expect((v.dailyRecap?.yourDay ?? []).length, "the review has the player's own witnessed scenes").toBeGreaterThan(0);
    expect(v.dailyRecap!.yourDay!.length).toBeLessThanOrEqual(5);
    for (const line of v.dailyRecap!.yourDay!) expect(line, "no provenance bookkeeping reaches the review").not.toMatch(/^surfaced to player via|overheard:|told-by:/);
  });
});
