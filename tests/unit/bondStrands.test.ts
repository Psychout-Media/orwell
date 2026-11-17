import { describe, it, expect } from "vitest";
import { emptyBond, strandsOf } from "../../src/engine/bondRecord";
import { feeling, protectiveFeeling, hesitation } from "../../src/engine/bondFeelings";
import { chooseHourAction } from "../../src/engine/houseLife";

/** ORW-622 - mixed relationships: a bond carries several strands at once, and behaviour splits. Roles only: a holder, the other, a mate. */
describe("strands (bondRecord.ts)", () => {
  it("a bond carries several strands at once: a showmance, a final-two pact and a grudge together", () => {
    const r = { ...emptyBond(), warmth: 0.6, romance: 3, commitment: "final-two" as const, resentment: 0.5, debt: -0.25 };
    const st = strandsOf(r);
    expect(Object.keys(st).sort()).toEqual(["friendship", "owing", "pact", "rivalry", "romance"]);
    expect(st.pact).toBeGreaterThan(0.5);
    expect(st.rivalry).toBeCloseTo(0.5, 12);
  });
  it("a stranger carries no strands", () => {
    expect(strandsOf(emptyBond())).toEqual({});
  });
});

describe("behaviour splits: protect them at the vote, resent them at dinner", () => {
  const torn = { warmth: 0.6, resentment: 0.8, strain: 0, strands: strandsOf({ ...emptyBond(), warmth: 0.6, romance: 0, commitment: "final-two", resentment: 0.8 }) };
  it("at the vote: a pact still protects through a grudge (the old single feeling let the grudge cancel it)", () => {
    expect(feeling(torn)).toBeLessThan(0.15); // warmth cut by the grudge
    expect(protectiveFeeling(torn)).toBeGreaterThan(0.35); // the pact holds
    expect(hesitation(torn)).toBeGreaterThan(hesitation({ ...torn, strands: undefined }));
  });
  it("without strands (the edge-only reader) it reads exactly as before", () => {
    const plain = { warmth: 0.6, resentment: 0.8, strain: 0.2 };
    expect(hesitation(plain)).toBe(hesitation({ ...plain, strands: undefined }));
  });
  it("at dinner: the same grudge makes friction with someone they are warm toward far more likely", () => {
    const base = {
      owner: "h", character: { archetype: "hothead", strategyStyle: "aggressive" } as never, habits: [] as never, emotional: 0.4, room: "kitchen" as never,
      whereabouts: new Map([["h", "kitchen"], ["o", "kitchen"]]) as never, affinity: new Map([["o", 0.7]]), threat: new Map([["o", 0.1]]), mates: [], nominees: [],
      timeOfDay: "afternoon" as never, hour: 14, inCompetition: false, candor: 0.5,
    };
    let warm = 0, torn2 = 0;
    for (let day = 1; day <= 120; day++) {
      if (chooseHourAction({ ...base, day } as never, 7).kind === "chore-fight") warm++;
      if (chooseHourAction({ ...base, day, rivalry: new Map([["o", 0.8]]) } as never, 7).kind === "chore-fight") torn2++;
    }
    expect(torn2).toBeGreaterThan(warm);
  });
});
