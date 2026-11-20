import { describe, expect, it } from "vitest";
import { SHOWMANCE_PACE } from "../../src/engine/attractionLife";
import { freshPace, paceFactor, paceTick, stageOfLevel, type PaceInput, type PaceRecord } from "../../src/engine/showmancePace";

/** ORW-736: the pace of a showmance (pure). Roles only. */
const base = (o: Partial<PaceInput> = {}): PaceInput => ({ day: 1, shared: 0, mutualChemistry: 0.8, inCrisis: false, observers: [], room: 10, closeObservers: 0, factor: 1, ...o });
const crowd = (n: number): string[] => Array.from({ length: n }, (_, i) => `hg${i}`);
/** Run daily ticks: together `perDay` shared days each day, from `start`, with everyone having caught it from `noticeFrom` on. */
function run(rec: PaceRecord, days: number, perDay: number, o: Partial<PaceInput> & { start?: number; caught?: number; close?: number } = {}): PaceRecord {
  let r = rec, shared = r.lastShared;
  const from = o.start ?? rec.lastDay;
  for (let d = 0; d < days; d++) {
    shared += perDay;
    const day = from + d + 1;
    r = paceTick(r, base({ ...o, day, shared, observers: crowd(o.caught ?? 0), closeObservers: o.close ?? (o.caught ? 1 : 0) }));
  }
  return r;
}

describe("showmance pace (ORW-736)", () => {
  it("a pair with plenty of chemistry but too few days does not advance", () => {
    // a huge pile of shared time lands in one tick on day 2: the chemistry bar is long past, the days in the level are not
    const r = paceTick(freshPace(1, 0), base({ day: 2, shared: 50, mutualChemistry: 1 }));
    expect(r.level).toBe(0);
    expect(r.progress).toBeGreaterThan(SHOWMANCE_PACE.bars[0]);
    expect(r.steps).toEqual([]);
  });

  it("enough days but not enough chemistry accrued does not advance either", () => {
    const r = run(freshPace(1, 0), 20, 0.02);
    expect(r.level).toBe(0);
  });

  it("builds step by step over days, each step recorded in order", () => {
    const r = run(freshPace(1, 0), 60, 0.8, { caught: 8, close: 2 });
    expect(r.level).toBe(4);
    expect(r.steps.map((s) => [s.from, s.to])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    // every step waits out its own minimum days in the level before it
    for (let i = 1; i < r.steps.length; i++) expect(r.steps[i]!.day - r.steps[i - 1]!.day).toBeGreaterThanOrEqual((SHOWMANCE_PACE.minDays as readonly number[])[r.steps[i]!.from]!);
  });

  it("a public couple does not form before the late day even when everything else is ready", () => {
    const r = run(freshPace(1, 0), SHOWMANCE_PACE.publicNotBeforeDay - 2, 3, { caught: 10, close: 3 });
    expect(r.level).toBe(3);
    expect(Math.max(...r.steps.map((s) => s.day))).toBeLessThan(SHOWMANCE_PACE.publicNotBeforeDay);
    const later = run(r, 8, 3, { caught: 10, close: 3 });
    expect(later.level).toBe(4);
    expect(later.steps.at(-1)!.day).toBeGreaterThanOrEqual(SHOWMANCE_PACE.publicNotBeforeDay);
  });

  it("noticing needs people: sensed needs a close ally, noticed a share of the room, known most of the house; each step records who", () => {
    let r = run(freshPace(1, 0), 12, 1, { caught: 0 });
    expect(r.level).toBe(1); // grown close, nobody has caught it
    r = run(r, 12, 1, { caught: 1, close: 0 });
    expect(r.level).toBe(1); // one person, not a close ally of either
    r = run(r, 12, 1, { caught: 1, close: 1 });
    expect(r.level).toBe(2);
    expect(r.steps.at(-1)!.seenBy).toEqual(["hg0"]);
    r = run(r, 12, 1, { caught: 1, close: 1 });
    expect(r.level).toBe(2); // one of ten is not the room
    r = run(r, 12, 1, { caught: 4, close: 1 });
    expect(r.level).toBe(3);
    expect(r.steps.at(-1)!.seenBy).toHaveLength(4);
  });

  it("stalls while apart (it cools) and while either is in crisis (it holds)", () => {
    let r = run(freshPace(1, 0), 10, 0.8, { caught: 0 });
    const level = r.level, progress = r.progress;
    const crisis = run(r, 10, 0.8, { inCrisis: true });
    expect(crisis.level).toBe(level);
    expect(crisis.progress).toBe(progress); // neither builds nor cools
    const apart = run(r, 3, 0, {});
    expect(apart.progress).toBeLessThan(progress);
    expect(apart.level).toBe(level); // a few days apart is a pause
  });

  it("fades one step when it loses its footing, recorded, never deleted; a known couple does not fade", () => {
    let r = run(freshPace(1, 0), 30, 0.8, { caught: 2, close: 1 });
    expect(r.level).toBeGreaterThanOrEqual(2);
    const stepsBefore = r.steps.length;
    const lvl = r.level;
    r = run(r, 60, 0, {});
    expect(r.level).toBeLessThan(lvl);
    expect(r.steps.length).toBeGreaterThan(stepsBefore);
    expect(r.steps.slice(0, stepsBefore)).toEqual(r.steps.slice(0, stepsBefore)); // append-only: the old rows are still the first rows
    expect(r.steps.some((s) => s.to < s.from)).toBe(true);
    // a public couple stays public
    let k = run(freshPace(1, 0), 80, 3, { caught: 10, close: 3 });
    expect(k.level).toBe(4);
    k = run(k, 100, 0, {});
    expect(k.level).toBe(4);
  });

  it("falls back at most one step per tick", () => {
    const r: PaceRecord = { level: 3, progress: 0, since: 1, lastDay: 10, lastTogetherDay: 1, lastShared: 5, steps: [] };
    expect(paceTick(r, base({ day: 11, shared: 5 })).level).toBe(2);
  });

  it("the per-pair pace is a keyed, deterministic spread, so pairs differ", () => {
    expect(paceFactor(7, "a|b")).toBe(paceFactor(7, "a|b"));
    const fs = Array.from({ length: 30 }, (_, i) => paceFactor(7, `p${i}|q${i}`));
    expect(new Set(fs).size).toBeGreaterThan(20);
    for (const f of fs) { expect(f).toBeGreaterThanOrEqual(1 - SHOWMANCE_PACE.jitter); expect(f).toBeLessThanOrEqual(1 + SHOWMANCE_PACE.jitter); }
  });

  it("maps to the existing stages", () => {
    expect([0, 1, 2, 3, 4].map((l) => stageOfLevel(l as 0 | 1 | 2 | 3 | 4))).toEqual(["spark", "bond", "bond", "bond", "visible"]);
  });
});
