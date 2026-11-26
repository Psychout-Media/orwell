import { describe, it, expect, vi, afterEach } from "vitest";
import { firstSeedWhere, firstSeedWhereSync, firstSeedsWhere, firstSeedsWhereSync, seedOrder, NotReached, SCAN_BOUND } from "../support/firstSeedWhere";

/** ORW-880: the seed scan the real-path tests use instead of a hard-pinned seed. No game is played here: `reach` is a stand-in. */
afterEach(() => vi.restoreAllMocks());

describe("ORW-880 firstSeedWhere", () => {
  it("tries the hint first, then the range in ascending order, each seed once", () => {
    expect(seedOrder({ from: 1, to: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(seedOrder({ from: 1, to: 5, hint: 3 })).toEqual([3, 1, 2, 4, 5]);
    expect(seedOrder({ from: 1, to: 3, hint: 9 })).toEqual([9, 1, 2, 3]);
    expect(seedOrder({ from: 1, to: 5, hint: [4, 2, 4] })).toEqual([4, 2, 1, 3, 5]);
    expect(() => seedOrder({ from: 5, to: 1 })).toThrow(/bad seed range/);
  });

  it("returns the first qualifying seed with its fixed sandbox name, the same on every run", async () => {
    const reach = (seed: number, sandbox: string) => (seed % 4 === 0 ? { seed, sandbox } : undefined);
    const scan = { from: 1, to: 10, sandbox: (s: number) => `wf-${s}` };
    const a = await firstSeedWhere(reach, scan);
    const b = await firstSeedWhere(reach, scan);
    expect(a).toEqual({ seed: 4, sandbox: "wf-4", at: { seed: 4, sandbox: "wf-4" } });
    expect(b).toEqual(a);
    expect(firstSeedWhereSync(reach, scan)).toEqual(a);
  });

  it("a hint that still qualifies plays one game and says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const played: number[] = [];
    const r = await firstSeedWhere((seed) => { played.push(seed); return seed >= 2 ? seed : undefined; }, { from: 1, to: 9, hint: 7, sandbox: (s) => `x-${s}` });
    expect(r.seed).toBe(7);
    expect(played).toEqual([7]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a hint that no longer qualifies falls back to the scan and says which seed to pin next", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await firstSeedWhere((seed) => (seed === 5 ? "here" : undefined), { from: 1, to: 9, hint: 3, sandbox: (s) => `x-${s}`, what: "a jealous night" });
    expect(r).toMatchObject({ seed: 5, sandbox: "x-5", at: "here" });
    expect(warn.mock.calls[0]![0]).toMatch(/hint seed 3 no longer reaches a jealous night; seed 5 does/);
  });

  it("a season that never gets there (NotReached) moves on; any other error is a real failure", async () => {
    const r = await firstSeedWhere(async (seed) => { if (seed < 3) throw new NotReached(`seed ${seed}: the season ended`); return seed; }, { from: 1, to: 5, sandbox: (s) => `x-${s}` });
    expect(r.seed).toBe(3);
    await expect(firstSeedWhere(() => { throw new TypeError("a bug in the test"); }, { from: 1, to: 5, sandbox: (s) => `x-${s}` })).rejects.toThrow(TypeError);
    expect(() => firstSeedWhereSync(() => { throw new RangeError("boom"); }, { from: 1, to: 2, sandbox: (s) => `x-${s}` })).toThrow(RangeError);
  });

  it("fails loudly, naming the range and why each seed failed, when no seed qualifies", async () => {
    const scan = { from: 1, to: 3, sandbox: (s: number) => `x-${s}`, what: "a week-2 house with a close friend" };
    const reach = (seed: number) => { if (seed === 2) throw new NotReached("the season ended before week 2"); return undefined; };
    await expect(firstSeedWhere(reach, scan)).rejects.toThrow(/no seed in 1\.\.3 reached a week-2 house with a close friend \(tried 3: 1: reached, precondition false; 2: the season ended before week 2; 3: reached, precondition false\)/);
    expect(() => firstSeedWhereSync(reach, scan)).toThrow(/no seed in 1\.\.3/);
  });

  it("several games: the first n distinct qualifying seeds, hints first; a hint that fails is named; too few fails loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scan = { from: 1, to: 12, hint: [3, 11], sandbox: (s: number) => `wf-${s}`, what: "a seeking holder", wide: { maxSeasons: 12, reason: "this test exercises the n-seed fallback across the whole range" } };
    const ok = (seed: number) => (seed === 3 || seed === 11 || seed === 6 ? seed : undefined);
    expect((await firstSeedsWhere(2, ok, scan)).map((f) => f.seed)).toEqual([3, 11]);
    expect(warn).not.toHaveBeenCalled();
    const drift = (seed: number) => (seed === 3 || seed === 6 ? seed : undefined);
    expect(firstSeedsWhereSync(2, drift, scan).map((f) => [f.seed, f.sandbox])).toEqual([[3, "wf-3"], [6, "wf-6"]]);
    expect(warn.mock.calls[0]![0]).toMatch(/hint seed 11 no longer reaches a seeking holder; seeds 3, 6 do/);
    await expect(firstSeedsWhere(3, drift, scan)).rejects.toThrow(/not enough seeds in 1\.\.12 reached a seeking holder \(2 of the 3 needed\)/);
  });

  describe("ORW-967: a scan is bounded (a few seasons, a few minutes) and fails fast at the bound", () => {
    const never = () => undefined;
    it("by default at most a few seasons are played, then it fails naming the bound and the seeds tried", async () => {
      const played: number[] = [];
      const scan = { from: 1, to: 30, hint: [17, 24], sandbox: (s: number) => `wf-${s}`, what: "the vote talk the test needs" };
      await expect(firstSeedWhere((s) => { played.push(s); return never(); }, scan)).rejects.toThrow(/reached the vote talk the test needs \(tried 5: 17: .*; stopped at the bound: 5 seasons tried/);
      expect(played).toEqual([17, 24, 1, 2, 3]);
      expect(played).toHaveLength(SCAN_BOUND.maxSeasons);
      expect(() => firstSeedWhereSync(never, scan)).toThrow(/stopped at the bound/);
    });
    it("n seeds: n plus a few", () => {
      const played: number[] = [];
      expect(() => firstSeedsWhereSync(3, (s) => { played.push(s); return s === 1 ? s : undefined; }, { from: 1, to: 30, sandbox: (s) => `x-${s}` })).toThrow(/stopped at the bound: 7 seasons/);
      expect(played).toHaveLength(3 + SCAN_BOUND.extraSeasons);
    });
    it("no new season starts once the time budget has passed", () => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const played: number[] = [];
      expect(() => firstSeedWhereSync((s) => { played.push(s); now += SCAN_BOUND.budgetMs; return undefined; }, { from: 1, to: 30, sandbox: (s) => `x-${s}` })).toThrow(/stopped at the bound: 600 s of scanning/);
      expect(played).toEqual([1, 2]);
    });
    it("a caller that needs more says so, with a reason; without one it is refused", () => {
      const played: number[] = [];
      expect(firstSeedWhereSync((s) => { played.push(s); return s === 9 ? s : undefined; }, { from: 1, to: 30, sandbox: (s) => `x-${s}`, wide: { maxSeasons: 12, reason: "a rare state" } }).seed).toBe(9);
      expect(played).toHaveLength(9);
      expect(() => firstSeedWhereSync(never, { from: 1, to: 30, sandbox: (s) => `x-${s}`, wide: { maxSeasons: 12, reason: " " } })).toThrow(/must give its reason/);
    });
    it("a seed found inside the bound is found as before", () => {
      expect(firstSeedWhereSync((s) => (s === 5 ? s : undefined), { from: 1, to: 30, sandbox: (s) => `x-${s}` }).seed).toBe(5);
    });
  });
});
