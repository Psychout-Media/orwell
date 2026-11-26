import { describe, it, expect } from "vitest";
import { claimBed, type BedsState } from "../../src/engine/beds";
import { BED_RULES } from "../../src/engine/bedClaims";

/**
 * ORW-1046 (Ryne's ruling 2026-11-26, "Yes, it's fair game"): an EMPTY half of a double is up for grabs without the sleeping houseguest's yes. The
 * sleeper's veto (`halfDoublePartnerVeto`) applies only to a SWAP into an occupied half. Same rule for a houseguest taking a half beside a sleeping player
 * or houseguest (parity): the claim of a free spot takes no consent argument at all. Roles only.
 */
const half = (n: 1 | 2) => `bedroom-a#d1:${n}`;
const inHouse = (...ids: string[]) => new Set(ids);

describe("ORW-1046: a free half of a double is taken without the sleeper's yes", () => {
  it("the veto rule is about swaps (an occupied half), not about joining an empty half", () => {
    expect(BED_RULES.halfDoublePartnerVeto).toBe(true); // still on: it guards decideSwap into an occupied half
    expect(claimBed.length, "claimBed takes no partner-consent argument (who, bed, day, why, inHouse, layout?)").toBeLessThanOrEqual(6);
  });
  it("the player takes the free half beside a sleeping houseguest: it lands", () => {
    const s: BedsState = { owner: { npcA: half(1) }, claims: [] };
    expect(claimBed(s, "player", half(2), 1, "move", inHouse("player", "npcA"))).toBe(true);
    expect(s.owner["player"]).toBe(half(2));
    expect(s.owner["npcA"], "the sleeper keeps their half").toBe(half(1));
  });
  it("parity: a houseguest takes the free half beside a sleeping player, and beside a sleeping houseguest", () => {
    const a: BedsState = { owner: { player: half(1) }, claims: [] };
    expect(claimBed(a, "npcB", half(2), 1, "move", inHouse("player", "npcB"))).toBe(true);
    const b: BedsState = { owner: { npcA: half(1) }, claims: [] };
    expect(claimBed(b, "npcB", half(2), 1, "move", inHouse("npcA", "npcB"))).toBe(true);
  });
  it("an occupied half is still not claimable (only a swap, with its own veto, moves into it)", () => {
    const s: BedsState = { owner: { npcA: half(1), npcB: half(2) }, claims: [] };
    expect(claimBed(s, "player", half(2), 1, "move", inHouse("player", "npcA", "npcB"))).toBe(false);
  });
});
