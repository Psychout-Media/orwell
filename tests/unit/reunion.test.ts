import { describe, it, expect } from "vitest";
import { REUNION, afterTheCrown, confrontations, liesComingOut, alliancesToExplain, arcShape, turningPoints } from "../../src/engine/reunion";

/** ORW-649 + 648 foundation: the reunion and the story of you and them. Roles only. */
const P = "player", A = "npc:a", B = "npc:b", C = "npc:c";

describe("649: the reunion airs what the season hid, only after the crown", () => {
  it("is closed until the crown", () => { expect(afterTheCrown(false)).toBe(false); expect(afterTheCrown(true)).toBe(true); });
  it("confrontations: the biggest grudges, a mutual one counted once, the player on either side", () => {
    const c = confrontations([{ holder: A, at: P, size: 0.5 }, { holder: P, at: A, size: 0.4 }, { holder: B, at: C, size: 0.6 }, { holder: C, at: B, size: 0.1 }, { holder: A, at: C, size: 0.2 }]);
    expect(c[0]).toMatchObject({ size: 0.9 });
    expect([c[0]!.a, c[0]!.b].sort()).toEqual([A, P].sort());
    expect(c).toHaveLength(2);
  });
  it("lies come out only if never caught, earliest first; hidden alliances are explained, longest first", () => {
    const lies = liesComingOut([
      { id: "l1", speaker: A, listener: P, isTrue: false, caught: false, week: 3 },
      { id: "l2", speaker: P, listener: B, isTrue: false, caught: false, week: 1 },
      { id: "l3", speaker: B, listener: C, isTrue: false, caught: true, week: 1 },
      { id: "t", speaker: C, listener: A, isTrue: true, caught: false, week: 1 },
    ]);
    expect(lies.map((l) => l.id)).toEqual(["l2", "l1"]);
    const g = alliancesToExplain([{ id: "g1", members: [A, B], hiddenFrom: [], weeks: 9 }, { id: "g2", members: [A, C], hiddenFrom: [P], weeks: 4 }, { id: "g3", members: [B, P], hiddenFrom: [A], weeks: 6 }]);
    expect(g.map((x) => x.id)).toEqual(["g3", "g2"]);
    expect(g.length).toBeLessThanOrEqual(REUNION.maxAlliances);
  });
});

describe("648: the story of you and them has a shape and turning points", () => {
  it("warmed, cooled, turned or steady", () => {
    expect(arcShape([{ week: 1, trust: 0.1, affinity: 0.1 }, { week: 5, trust: 0.4, affinity: 0.3 }])).toBe("warmed");
    expect(arcShape([{ week: 1, trust: 0.4, affinity: 0.3 }, { week: 5, trust: 0.2, affinity: 0.2 }])).toBe("cooled");
    expect(arcShape([{ week: 1, trust: 0.3, affinity: 0.2 }, { week: 5, trust: -0.3, affinity: -0.1 }])).toBe("turned");
    expect(arcShape([{ week: 1, trust: 0.2, affinity: 0.2 }, { week: 5, trust: 0.25, affinity: 0.2 }])).toBe("steady");
  });
  it("the turning points are the weeks the view moved most", () => {
    const tp = turningPoints([{ week: 1, trust: 0.2, affinity: 0.2 }, { week: 2, trust: 0.25, affinity: 0.2 }, { week: 3, trust: -0.2, affinity: 0 }, { week: 4, trust: 0, affinity: 0.1 }]);
    expect(tp[0]!.week).toBe(3);
    expect(tp.map((t) => t.week)).toEqual([3, 4]);
  });
});
