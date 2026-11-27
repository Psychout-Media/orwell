import { describe, it, expect } from "vitest";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";
import { parsePlayerBedIntent } from "../../src/engine/bedClaims";
import type { Room } from "../../src/domain/house";

/**
 * ORW-1033 (audit 11-26 A3): out-of-character text is not the player's act. "((let's go to the kitchen))", "OOC: ...", "[ooc] ...", "(OOC) ..." and single-quoted speech
 * must not move the player or claim a bed (a bed claim is persistent state). Every positive line, wrapped in an OOC form, must read as nothing; the unwrapped line still reads.
 * An unbalanced quote must not glue two clauses ("I say "go to the kitchen." I go to the lounge" is a move to the lounge). Roles only.
 */
const rooms = [{ room: "bedroom-b" as Room, names: ["bedroom b"] }];
const people = [{ id: "npc", names: ["Dana"] }];
const MOVES = ["I go to the kitchen", "let's go to the kitchen", "I head to the kitchen", "I walk to the kitchen"];
const BEDS = ["I take a bed in bedroom B", "can I take a bed in bedroom B?", "I claim the bed in bedroom B"];
const WRAPS: Array<[string, (s: string) => string]> = [
  ["double parentheses", (s) => `(( ${s} ))`], ["tight double parentheses", (s) => `((${s}))`], ["OOC: prefix", (s) => `OOC: ${s}`],
  ["[ooc] prefix", (s) => `[ooc] ${s}`], ["(OOC) prefix", (s) => `(OOC) ${s}`], ["said in single quotes", (s) => `I say '${s}'`], ["told someone in single quotes", (s) => `I tell Dana '${s}'`],
];

describe("ORW-1033: out-of-character text never moves the player or claims a bed", () => {
  for (const [name, wrap] of WRAPS) {
    it(`a move wrapped as ${name} reads as no move; the plain line still moves`, () => {
      for (const m of MOVES) { expect(parsePlayerMoveIntent(wrap(m), "backyard"), wrap(m)).toBeNull(); expect(parsePlayerMoveIntent(m, "backyard"), m).toBe("kitchen"); }
    });
    it(`a bed claim wrapped as ${name} reads as no claim; the plain line still claims`, () => {
      for (const b of BEDS) { expect(parsePlayerBedIntent(wrap(b), rooms, people), wrap(b)).toBeNull(); expect(parsePlayerBedIntent(b, rooms, people)?.kind, b).toBe("claim"); }
    });
  }
  it("an OOC aside then a real act: only the act is read", () => {
    expect(parsePlayerMoveIntent("(( go to the kitchen )) I stay here", "backyard")).toBeNull();
    expect(parsePlayerMoveIntent("(( I go to the kitchen. Actually, no. ))", "backyard")).toBeNull();
  });
  it("a quoted sentence does not glue the clauses around it", () => {
    expect(parsePlayerMoveIntent('I say "go to the kitchen." I go to the lounge.', "backyard")).toBe("lounge");
  });
});
