import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DailyRecapView } from "../../src/ports/GameSession";
import { firstStop, bedtimeNow, wfScan } from "./playedSeason";

/**
 * ORW-1165 (Ryne's Day 1 digest: highlights 0 after a full premiere): the builder counted only ceremony, deal and betrayal events, so the arrivals, the toast and the player's own
 * talks never reached the review. A played premiere day (seeded, the real path) now yields a digest of many lines across many kinds, from witnessed events only. Roles only.
 */
const SEED = 3;
describe("ORW-1165 - a played premiere day yields a rich, witnessed-only digest", () => {
  it("at least 8 highlights across at least 5 kinds, every line from the player's own witnessed day", async () => {
    const at = await firstStop(bedtimeNow, wfScan(SEED));
    const hiddenText = at.engine.events.queryAll().filter((e) => e.hidden && !e.witnessSet.includes(PLAYER)).map((e) => String(e.content)).filter((c) => c.trim().length > 8);
    const v = (await at.call("turnIn", {})) as { dailyRecap?: DailyRecapView };
    const r = v.dailyRecap!;
    expect(r.day).toBe(1);
    expect(r.highlights.length).toBeGreaterThanOrEqual(8);
    expect(new Set((r.digest ?? []).map((d) => d.kind)).size).toBeGreaterThanOrEqual(5);
    expect((r.digest ?? []).map((d) => d.text)).toEqual(r.highlights);
    const dump = JSON.stringify(r);
    for (const c of hiddenText) expect(dump).not.toContain(c);
    // the digest names the arrivals, the toast and a one-to-one by kind
    const kinds = new Set((r.digest ?? []).map((d) => d.kind));
    for (const k of ["arrival", "toast", "deal"]) expect(kinds.has(k), k).toBe(true);
    expect(await at.call("dailyRecap", {})).toEqual(r); // re-read: the same digest
  }, 200_000);

  it("a closed day is rebuilt on request with the same digest, as a pure read (also for a recap made before ranges were kept)", async () => {
    const at = await firstStop(bedtimeNow, wfScan(SEED));
    const r = ((await at.call("turnIn", {})) as { dailyRecap: DailyRecapView }).dailyRecap;
    const before = JSON.stringify(await at.call("dailyRecap", {}));
    const again = (await at.call("dailyRecap", { rebuildDay: 1 })) as DailyRecapView;
    expect(again.digest).toEqual(r.digest);
    expect(again.surfaced).toEqual(r.surfaced);
    expect(JSON.stringify(await at.call("dailyRecap", {}))).toBe(before); // nothing stored, no cursor moved
    expect(await at.call("dailyRecap", { rebuildDay: 7 })).toBeNull();
    delete (at.sess.live as { dailyRecapRanges?: unknown }).dailyRecapRanges; // a save from before the ranges: the latest recap ends at the live cursor and the first starts at 0
    const legacy = (await at.call("dailyRecap", { rebuildDay: 1 })) as DailyRecapView;
    expect(legacy.digest).toEqual(r.digest);
  }, 200_000);
});
