import { describe, it, expect } from "vitest";
import { phaseOfWeek, poolByPhase, poolSeason, evaluate, ratchet, inBand, BANDS, KNOWN_RED, type PhaseShares, type Share } from "../support/wholeSeasonMix";
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

describe("the KNOWN_RED ratchet", () => {
  const bad = evaluate({ ...centre, mid: sh(100, 14, 30, 36, 10) }); // mid bonding 14 (10 under)
  it("a failing rule that is not listed is a regression", () => {
    expect(ratchet(bad, {}).regressions).toEqual(["mid:band-bonding: bonding share within its mid band 24-34, measured 14"]);
  });
  it("a listed rule that still fails is fine", () => {
    const v = ratchet(bad, { "mid:band-bonding": { value: 14, card: "X" } });
    expect(v).toEqual({ regressions: [], fixed: [], worse: [], red: ["mid:band-bonding"] });
  });
  it("a listed rule that now passes must be moved out", () => {
    const v = ratchet(evaluate(centre), { "mid:band-bonding": { value: 14, card: "X" } });
    expect(v.fixed.length).toBe(1); expect(v.fixed[0]).toContain("delete it from KNOWN_RED");
  });
  it("a listed rule that got worse by more than the slack is flagged", () => {
    const worse = evaluate({ ...centre, mid: sh(100, 5, 30, 36, 10) });
    expect(ratchet(worse, { "mid:band-bonding": { value: 14, card: "X" } }, 6).worse.length).toBe(1);
    expect(ratchet(worse, { "mid:band-bonding": { value: 14, card: "X" } }, 20).worse).toEqual([]);
  });
  it("a listed rule for a phase that has no scenes is flagged (the table must not rot)", () => {
    expect(ratchet(evaluate({ ...centre, late: sh(0, 0, 0, 0, 0) }), { "late:band-gossip": { value: 40, card: "X" } }).fixed.length).toBe(1);
  });
  it("room says how far inside the limit a passing rule is, and fixedMargin keeps a borderline pass from forcing a move", () => {
    const r = evaluate(centre).find((x) => x.id === "mid:band-bonding")!;
    expect(r.room).toBe(5); // 29 in 24-34
    expect(ratchet([r], { "mid:band-bonding": { value: 14, card: "X" } }, 6, 6).fixed).toEqual([]);
    expect(ratchet([r], { "mid:band-bonding": { value: 14, card: "X" } }, 6, 5).fixed.length).toBe(1);
  });
  it("every KNOWN_RED id names a real rule", () => {
    const ids = new Set(evaluate(centre).map((r) => r.id));
    for (const id of Object.keys(KNOWN_RED)) expect(ids.has(id), id).toBe(true);
  });
  it("hysteresis: a listed rule that passes by less than RATCHET_FIXED_MARGIN is not yet asked to leave KNOWN_RED, one that clears it by the margin is", () => {
    const edge = { id: "mid:band-bonding", what: "w", value: 24.4, pass: true, miss: 0, room: 0.4 } as never;
    const clear = { id: "mid:band-bonding", what: "w", value: 25.5, pass: true, miss: 0, room: 1.5 } as never;
    const known = { "mid:band-bonding": { value: 14, card: "X" } };
    expect(ratchet([edge], known).fixed).toEqual([]);
    expect(ratchet([clear], known).fixed.length).toBe(1);
  });
  it("hysteresis, the other way: an unlisted rule that misses by no more than the margin is noise, one that misses by more is a regression", () => {
    const near = { id: "mid:band-bonding", what: "w", value: 23.5, pass: false, miss: 0.5, room: 0 } as never;
    const far = { id: "mid:band-bonding", what: "w", value: 22.5, pass: false, miss: 1.5, room: 0 } as never;
    expect(ratchet([near], {}).regressions).toEqual([]);
    expect(ratchet([far], {}).regressions.length).toBe(1);
  });
});
