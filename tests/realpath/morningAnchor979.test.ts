import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { type Stop, firstStop, wfScan } from "./playedSeason";
import { upBeforeTheCall } from "../../src/engine/routines";

/**
 * ORW-979 / spec 0209 slice 7.1: the morning anchor, in a PLAYED season (the scripted talking player on the production runtime; nothing set by hand). Measured before the build: in the two hours before
 * the 8am call the house had 0-3 houseguests awake (mean about one). With the anchor on, every houseguest whose own routines put them up before the call (`upBeforeTheCall`) is awake in those two hours and
 * nobody else is added; with it off the set is the old one. Roles only.
 */
const earlyHours = (s: Stop): boolean => {
  const live = s.sess.snapshot().live;
  const h = live?.nightDepth;
  const day = live?.dayNumber ?? 0;
  if (h === undefined || day < 3) return false;
  const hh = h >= 24 ? h - 24 : h;
  if (h >= 8 && h < 24) return false;
  if (!(hh >= 6 && hh < 8)) return false;
  // the stop is only interesting when someone is an early riser who would otherwise be out of the awake set
  const routines = (s.sess.live?.routines ?? {}) as Record<string, any[]>;
  s.sess.setMorningAnchorEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
  const off = new Set(s.sess.awakeAmong(s.sess.livingIds()) as string[]);
  s.sess.setMorningAnchorEnabled(true);
  return (s.sess.livingIds() as string[]).some((id) => id !== PLAYER && !off.has(id) && upBeforeTheCall(routines[id] ?? []));
};

describe("the morning anchor in a played season", () => {
  it("in the two hours before the call, early risers are up, and only they are added", async () => {
    const at = await firstStop(earlyHours, wfScan([3, 5, 7], "an early morning with an early riser still asleep"), { maxMessages: 1200 });
    const s = at.sess;
    const routines = (s.live?.routines ?? {}) as Record<string, any[]>;
    const ids = s.livingIds() as string[];
    s.setMorningAnchorEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
    const off = new Set(s.awakeAmong(ids) as string[]);
    s.setMorningAnchorEnabled(true);
    const on = new Set(s.awakeAmong(ids) as string[]);
    const added = [...on].filter((id) => !off.has(id));
    expect(added.length, "positive control: the anchor brought someone up, and only one").toBe(1);
    for (const id of added) expect(upBeforeTheCall(routines[id] ?? []), "only an early riser is added").toBe(true);
    for (const id of off) expect(on.has(id), "nobody who was up is put to sleep").toBe(true);
  }, 900_000);

  it("after the call the awake set is the old one (the anchor adds nothing in the day)", async () => {
    const at = await firstStop((s: Stop) => { const h = s.sess.snapshot().live?.nightDepth; return h !== undefined && h >= 9 && h < 20 && (s.sess.snapshot().live?.dayNumber ?? 0) >= 3; }, wfScan([3, 5], "a day hour"), { maxMessages: 900 });
    const ids = at.sess.livingIds() as string[];
    at.sess.setMorningAnchorEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
    const off = [...(at.sess.awakeAmong(ids) as string[])].sort();
    at.sess.setMorningAnchorEnabled(true);
    expect([...(at.sess.awakeAmong(ids) as string[])].sort()).toEqual(off);
  }, 900_000);
});
