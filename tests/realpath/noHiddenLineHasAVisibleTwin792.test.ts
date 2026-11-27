import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { Stop } from "./playedSeason";
import { sweepSeason, twins, type Ev } from "./hiddenTwinSweep";

// ORW-792: the sweep is described in ./hiddenTwinSweep.ts. Seeds 2-4 are in the sibling .seedN files (ORW-410).
describe("the sweep itself catches a twin (so a clean season means something)", () => {
  const stop = (events: Ev[], facts: string[] = []): Stop => ({ engine: { events: { queryAll: () => events }, knowledge: { knownTo: () => facts.map((content) => ({ content, pathway: "told-by:npc:1" })) } } } as unknown as Stop);
  const line = "Role Alpha and Role Bravo are in a tense exchange.";
  const hidden: Ev = { id: "h1", hidden: true, witnessSet: ["npc:1", "npc:2"], content: line };
  const seen: Ev = { id: "v1", hidden: false, witnessSet: [PLAYER], content: line };
  it("names both lines of a hidden/visible twin", () => { expect(twins(stop([hidden, seen]))).toEqual([expect.stringContaining("h1")]); });
  it("does not flag a hidden line the player holds through a real pathway, or one with no visible twin", () => {
    expect(twins(stop([hidden, seen], [line]))).toEqual([]);
    expect(twins(stop([hidden, { ...seen, content: "Something else entirely." }]))).toEqual([]);
  });
});

describe("no hidden engine line is a verbatim twin of a line the player sees (played)", () => {
  sweepSeason(1);
});
