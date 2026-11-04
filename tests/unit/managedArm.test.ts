import { describe, it, expect } from "vitest";
import { managedAnswer, type JuryCtx } from "../calibration/calibrationArms";

/** A1: the jury-managing `managed` arm's decisions (pure). Roles only. */
const o = (id: string) => ({ id, name: id });
const ctx = (wins: Record<string, number> = {}, aggrieved: string[] = []): JuryCtx => ({ aggrieved: new Set(aggrieved), compWins: new Map(Object.entries(wins)) });
const allies = new Set(["ally-1", "ally-2"]);

describe("A1 - the managed arm plays the jury-management levers", () => {
  it("nominations: biggest public threats first among NON-allies, never an ally, and marks them aggrieved", () => {
    const c = ctx({ a: 1, b: 4, c: 2 });
    const r = managedAnswer({ kind: "nominations", options: [o("ally-1"), o("a"), o("b"), o("c")] }, allies, c) as { choice: string[] };
    expect(r.choice).toEqual(["b", "c"]);
    expect([...c.aggrieved].sort()).toEqual(["b", "c"]);
  });
  it("final-eviction: evicts the finalist with the BIGGER public resume, keeping the weaker as the F2 rival", () => {
    const r = managedAnswer({ kind: "final-eviction", options: [o("big"), o("small")] }, allies, ctx({ big: 5, small: 1 })) as { vote: string };
    expect(r.vote).toBe("big");
    const r2 = managedAnswer({ kind: "final-eviction", options: [o("ally-1"), o("big")] }, allies, ctx({ big: 5 })) as { vote: string };
    expect(r2.vote).toBe("big"); // never the ally when the other is not one
  });
  it("goodbye: warm to an ally or to someone the player moved against, respectful otherwise", () => {
    const c = ctx({}, ["moved-against"]);
    expect(managedAnswer({ kind: "goodbye-message", options: [], evictee: o("ally-2") }, allies, c)).toMatchObject({ vote: "warm" });
    expect(managedAnswer({ kind: "goodbye-message", options: [], evictee: o("moved-against") }, allies, c)).toMatchObject({ vote: "warm" });
    expect(managedAnswer({ kind: "goodbye-message", options: [], evictee: o("stranger") }, allies, c)).toMatchObject({ vote: "respectful" });
  });
  it("finale: MEND for an aggrieved juror, CONNECT for a tended ally, own-game otherwise", () => {
    const c = ctx({}, ["hurt"]);
    const appeals = ["own-game", "mend", "connect", "discredit-rival"];
    const ans = (j: string) => (managedAnswer({ kind: "finale-answer", options: [], appeals, juror: o(j) }, allies, c) as { appeal: string }).appeal;
    expect(ans("hurt")).toBe("mend");
    expect(ans("ally-1")).toBe("connect");
    expect(ans("other")).toBe("own-game");
  });
});
