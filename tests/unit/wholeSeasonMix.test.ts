import { describe, it, expect } from "vitest";
import { phaseOfWeek, poolByPhase, poolSeason, evaluate, inBand, BANDS, type PhaseShares, type Share } from "../support/wholeSeasonMix";
import { BROKEN, socialBroken, seasonsIdentical, poBroken, gradientBroken, juryBroken } from "../support/brokenBounds";
import type { MixScene } from "../support/houseMixDriver";

/** ORW-702: the whole-season mix guard's machinery under CI (the guard itself plays seasons in the heavy lane). */
const sc = (type: string, week: number, playerOut = false): MixScene => ({ type, action: "a", msg: 0, week, playerOut });
const many = (type: string, week: number, n: number, out = false): MixScene[] => Array.from({ length: n }, () => sc(type, week, out));
const sh = (n: number, b: number, s: number, g: number, c: number): Share => ({ n, bonding: b, strategy: s, gossip: g, conflict: c });
const centre: PhaseShares = { early: sh(100, 37, 28, 27, 6.5), mid: sh(100, 29, 30, 31, 10), late: sh(100, 25, 33, 29, 13) };

describe("phase from week", () => {
  it("early 1-3, mid 4-8, late 9 on", () => {
    expect([1, 3, 4, 8, 9, 14].map(phaseOfWeek)).toEqual(["early", "early", "mid", "mid", "late", "late"]);
  });
});

describe("pooling", () => {
  it("pools scene counts across seasons per phase (a season with few scenes weighs less) and drops scenes after the player left", () => {
    const a = [...many("bonding", 1, 90), ...many("gossip", 1, 10)], b = [...many("gossip", 2, 10), ...many("bonding", 2, 0)];
    const p = poolByPhase([...a, ...b, ...many("conflict", 1, 50, true)]);
    expect(p.early.n).toBe(110);
    expect(p.early.bonding).toBeCloseTo((100 * 90) / 110, 5);
    expect(p.early.gossip).toBeCloseTo((100 * 20) / 110, 5);
    expect(p.early.conflict).toBe(0);
    expect(p.mid.n).toBe(0);
  });
  it("ignores scene kinds outside the four and reads the phase from the week, not the message", () => {
    const p = poolByPhase([{ ...sc("bonding", 9), msg: 1 }, { ...sc("showmance", 9) }, { ...sc("strategy", 4), msg: 99999 }]);
    expect(p.late.n).toBe(1); expect(p.mid.n).toBe(1);
  });
});

describe("the season reading", () => {
  it("reads a phase from the player-in scenes when there are enough, else from the whole house (and says which)", () => {
    const scenes = [...many("bonding", 1, 150), ...many("gossip", 10, 30), ...many("strategy", 10, 90, true), ...many("conflict", 10, 5, true)];
    const r = poolSeason(scenes, 100);
    expect(r.basis).toEqual({ early: "player-in", mid: "player-in", late: "house-after-player-left" });
    expect(r.shares.early.n).toBe(150); expect(r.shares.late.n).toBe(125); expect(r.shares.late.strategy).toBeCloseTo((100 * 90) / 125, 5);
    expect(poolSeason(scenes, 20).basis.late).toBe("player-in");
  });
});

describe("band and rule evaluation", () => {
  it("a mix at the centre of every band passes every rule", () => {
    const r = evaluate(centre);
    expect(r.filter((x) => !x.pass)).toEqual([]);
    expect(r.length).toBe(3 * (4 + 3) + 2 * 2);
  });
  it("marks a band miss with its distance", () => {
    const r = evaluate({ ...centre, mid: sh(100, 14, 30, 46, 10) });
    const f = Object.fromEntries(r.filter((x) => !x.pass).map((x) => [x.id, x.miss]));
    expect(f["mid:band-bonding"]).toBe(10); expect(f["mid:band-gossip"]).toBe(10); expect(f["mid:no-activity-above-45"]).toBe(1);
    expect(Object.keys(f).sort()).toEqual(["mid:band-bonding", "mid:band-gossip", "mid:no-activity-above-45"]);
  });
  it("hard rules: strategy under 50, conflict at most 16, floors from mid on only", () => {
    const f = (s: PhaseShares): string[] => evaluate(s).filter((x) => !x.pass && !x.id.includes("band-")).map((x) => x.id).sort();
    expect(f({ ...centre, late: sh(100, 15, 50, 25, 10) })).toEqual(["late:no-activity-above-45", "late:strategy-below-50"]);
    expect(f({ ...centre, mid: sh(100, 40, 22, 21, 17) })).toEqual(["mid:conflict-at-most-16", "mid:gossip-at-least-22", "mid:strategy-at-least-24"]);
    expect(f({ ...centre, early: sh(100, 50, 20, 20, 10) })).toEqual(["early:no-activity-above-45"]); // no floors in the early phase
  });
  it("skips a phase with no scenes", () => {
    expect(evaluate({ ...centre, late: sh(0, 0, 0, 0, 0) }).some((x) => x.phase === "late")).toBe(false);
  });
  it("band edges are inclusive", () => {
    for (const p of ["early", "mid", "late"] as const) for (const k of ["bonding", "strategy", "gossip", "conflict"] as const) {
      const [lo, hi] = BANDS[p][k]; expect(inBand(p, k, lo)).toBe(true); expect(inBand(p, k, hi)).toBe(true); expect(inBand(p, k, lo - 0.1)).toBe(false); expect(inBand(p, k, hi + 0.1)).toBe(false);
    }
  });
  it("the agreed bands are the PO's numbers", () => {
    expect(BANDS.early).toEqual({ bonding: [32, 42], strategy: [24, 32], gossip: [22, 32], conflict: [4, 9] });
    expect(BANDS.mid).toEqual({ bonding: [24, 34], strategy: [26, 34], gossip: [26, 36], conflict: [7, 13] });
    expect(BANDS.late).toEqual({ bonding: [20, 30], strategy: [28, 38], gossip: [24, 34], conflict: [10, 16] });
  });
});

describe("ORW-991: the build fails only on a broken game (Ryne 2026-11-26)", () => {
  it("social: a healthy mix, even far off the agreed bands, is not broken; a kind gone or one kind over 75% is", () => {
    expect(socialBroken(centre, 50)).toEqual([]);
    expect(socialBroken({ late: sh(400, 10, 20, 62, 8) }, 50), "a gossip-heavy late phase is a report, not broken").toEqual([]);
    expect(socialBroken({ mid: sh(400, 20, 30, 50, 0) }, 50)[0]).toMatch(/no conflict scenes at all/);
    expect(socialBroken({ mid: sh(400, 5, 10, 80, 5) }, 50)[0]).toMatch(/gossip is 80.0%.*swallowed/);
    expect(socialBroken({ mid: sh(30, 0, 0, 100, 0) }, 50), "too few scenes to read: not judged").toEqual([]);
    expect(BROKEN.socialOneKindSwallows).toBeGreaterThan(62.5); // the highest single healthy season measured
  });
  it("social: seasons that all read the same week 1 are broken; seasons that differ are not", () => {
    expect(seasonsIdentical({ bonding: 0.5, strategy: 0.4, gossip: 0.2, conflict: 0.1 }).length).toBe(1);
    expect(seasonsIdentical({ bonding: 12, strategy: 3, gossip: 9, conflict: 2 })).toEqual([]);
  });
  it("PO: broken only when solid never wins or reaches the Final 2, or passive out-wins solid by more than 5 points", () => {
    const arm = (wins: number, f2: number) => ({ seasons: 300, wins, reachedF2: f2 });
    expect(poBroken({ passive: arm(16, 25), solid: arm(18, 30) }), "solid below its 8% target is a report, not broken").toEqual([]);
    expect(poBroken({ passive: arm(10, 25), solid: arm(0, 30) })[0]).toMatch(/never won/);
    expect(poBroken({ passive: arm(10, 25), solid: arm(5, 0) })[0]).toMatch(/never reached the Final 2/);
    expect(poBroken({ passive: arm(40, 25), solid: arm(20, 30) })[0]).toMatch(/out-wins solid/);
    expect(poBroken({ passive: arm(30, 25), solid: arm(20, 30) }), "3.3 points is not wide").toEqual([]);
  });
  it("gradient: broken only when active never reaches the jury or trails passive by more than 25 points", () => {
    expect(gradientBroken(60, 52, 60)).toEqual([]);
    expect(gradientBroken(60, 48, 60), "a 20-point gap over 60 seasons is a report, not broken").toEqual([]);
    expect(gradientBroken(50, 0, 60).length).toBeGreaterThan(0);
    expect(gradientBroken(55, 30, 60)[0]).toMatch(/trails by more than 25/);
  });
  it("jury reach: broken only when nobody reaches it, nobody is evicted early, or a passive player wins most seasons", () => {
    expect(juryBroken(15, 5, 2, 20)).toEqual([]);
    expect(juryBroken(0, 20, 0, 20)[0]).toMatch(/no passive season reached the jury/);
    expect(juryBroken(20, 0, 2, 20)[0]).toMatch(/walks the player past/);
    expect(juryBroken(18, 2, 11, 20)[0]).toMatch(/hands out the crown/);
  });
});

