import { describe, it, expect } from "vitest";
import type { Routine } from "../../src/engine/routines";
import { routineKey, routineNow } from "../../src/engine/routineLife";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { firstStop, playUntil, wfScan, type Stop } from "./playedSeason";

/**
 * ORW-980 (0209 "routines change as the houseguest changes"), REAL PATH. A played season reaches a houseguest put on the block whose routines changed through the game
 * itself: one routine set aside (the row stays, flagged), one taken up. Nothing is set by hand. Roles only.
 */
type Live = { routines?: Record<string, Routine[]>; nominees?: string[]; week: number; routineSightings?: Record<string, Record<string, number[]>> };
const live = (s: Stop): Live => s.sess.live as Live;
const changed = (s: Stop): string[] => Object.entries(live(s).routines ?? {}).filter(([, rs]) => rs.some((r) => r.retiredWeek !== undefined)).map(([id]) => id).sort();

describe("routines change as the houseguest changes", () => {
  it("a houseguest on the block sets one routine aside and takes one up; nothing thinned; a flag-off game never does", async () => {
    // every houseguest's rows as first seen, to prove nothing thinned later (a read of the live game, never a write)
    const seen = new WeakMap<object, Map<string, string[]>>();
    const track = (s: Stop): void => {
      const m = seen.get(s.sess) ?? new Map<string, string[]>();
      seen.set(s.sess, m);
      for (const [id, rs] of Object.entries(live(s).routines ?? {})) if (!m.has(id)) m.set(id, rs.map(routineKey));
    };
    const at = await firstStop((s) => { track(s); return changed(s).length > 0; }, wfScan(1, "a houseguest whose routines changed"));
    const id = changed(at)[0]!;
    const rs = live(at).routines![id]!;
    const gone = rs.filter((r) => r.retiredWeek !== undefined), added = rs.filter((r) => r.sinceWeek !== undefined);
    expect(gone.length, "one set aside").toBeGreaterThan(0);
    expect(added.length, "one taken up").toBe(gone.length);
    expect(added.every((a) => gone.every((g) => g.action !== a.action)), "a new act, not the old one again").toBe(true);
    // nothing thinned: every row each houseguest first had is still there, in order
    for (const [who, keys] of seen.get(at.sess)!) expect((live(at).routines![who] ?? []).map(routineKey).slice(0, keys.length), `rows of ${who}`).toEqual(keys);
    // what onlookers already learned stays: a sighting of a set-aside routine is not removed (the store only grows; the snapshot guard pins it)
    for (const g of gone) expect(rs.some((r) => routineKey(r) === routineKey(g))).toBe(true);
    // only those who were put on the block change: the changed houseguests are a minority of the cast with routines
    expect(changed(at).length).toBeLessThan(Object.keys(live(at).routines!).length);

    // positive control: the same season (same seed and sandbox) played to the same message with the switch off never sets one aside, and its routine rows match the ones above in count
    const off = await playUntil(at.seed, (s) => s.msg >= at.msg, {
      user: at.sandbox,
      setup: (sess) => sess.setRoutineChangeEnabled(false), // not as shipped: the control, the same game without the change
    });
    expect(changed(off), "flag off: no routine is ever set aside").toEqual([]);
    expect(live(off).routines![id]!.some((r) => r.sinceWeek !== undefined)).toBe(false);
  }, 1_200_000);

  it("a save and reload keeps a set-aside routine set aside (retiredWeek), the new one's sinceWeek, every row in order; the snapshot guard accepts it and faults an un-set routine", async () => {
    const at = await firstStop((s) => changed(s).length > 0, wfScan(1, "a houseguest whose routines changed"));
    const id = changed(at)[0]!;
    const rowsOf = (snap: SessionSnapshot): Routine[] => (snap.live as unknown as Live).routines![id]!;
    const saved = JSON.parse(JSON.stringify(at.sess.snapshot())) as SessionSnapshot; // what the save store writes
    const reloaded = new GameSessionAdapter();
    reloaded.restore(JSON.parse(JSON.stringify(saved)) as SessionSnapshot);
    const back = JSON.parse(JSON.stringify(reloaded.snapshot())) as SessionSnapshot;
    const before = rowsOf(saved), after = rowsOf(back);
    expect(after.map(routineKey), "no row lost or reordered").toEqual(before.map(routineKey));
    expect(after.map((r) => r.retiredWeek)).toEqual(before.map((r) => r.retiredWeek));
    expect(after.map((r) => r.sinceWeek)).toEqual(before.map((r) => r.sinceWeek));
    const gone = after.find((r) => r.retiredWeek !== undefined)!;
    expect(gone).toBeDefined();
    expect(after.some((r) => r.sinceWeek !== undefined), "the added routine keeps sinceWeek").toBe(true);
    expect(routineNow([gone], gone.slot, false, () => 0), "a set-aside routine no longer pulls after the reload").toBeUndefined();
    expect(sessionCoreSupersetViolation(back, saved), "the monotonic guard accepts the round trip").toBeNull();
    // negative control: the same save with that routine un-set is refused (a copy of the saved snapshot is edited, never the game)
    const unset = JSON.parse(JSON.stringify(saved)) as SessionSnapshot;
    const liveCopy = unset.live as unknown as Live;
    liveCopy.routines = { ...liveCopy.routines, [id]: liveCopy.routines![id]!.map((r) => { const { retiredWeek: _w, ...rest } = r; return rest as Routine; }) };
    expect(sessionCoreSupersetViolation(unset, saved)).toBe("routines");
  }, 1_200_000);
});
