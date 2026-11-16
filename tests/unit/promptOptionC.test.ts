import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ORW-330 / Ryne's Theme 2 Q1 ruling (option C): the engine decides the SUBSTANCE of a consequential claim (a target, a vote, a final two);
 * the narrator keeps full creative freedom over the WORDING - spin, hedging, colour and small fibs that touch no game fact. Pins the three
 * prompt lines (source-level, as the prompt budget test does), so neither a "may lie about anything" line nor an over-restrictive
 * "voice only what the engine hands you" line comes back.
 */
const SRC = readFileSync("src/engine/momentPrompts.ts", "utf8");

describe("the narrator prompt under option C", () => {
  it("lets houseguests spin and fib in character, but states a game claim only as the game hands it", () => {
    expect(SRC).toContain("they may share, shade, spin or fib");
    expect(SRC).toContain("but a game claim (a target, a vote, a final two) only as the game hands it");
    expect(SRC).not.toContain("share, shade, or lie about");
  });
  it("the knowledge scope keeps the voice free and only fences game claims", () => {
    expect(SRC).toContain("spin, hedging and \" +\n        \"small fibs are fine, but never state as fact a game claim nobody here holds");
  });
  it("who-told-them leaves tone and hedging to the narrator, never who is named", () => {
    expect(SRC).toContain("tone, hedging and colour are yours, but never change who they name, or that they name no one");
    expect(SRC).not.toContain("never add, correct or doubt it");
  });
});
