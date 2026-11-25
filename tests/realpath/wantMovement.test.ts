import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { type Stop, playUntil, firstStop, firstStops, wfScan } from "./playedSeason";

/**
 * A10: NPC movement from one internal WANT (flag ORWELL_WANT_MOVEMENT) - in a PLAYED season (ORW-812: before, the house was played by a headless driver with every newer layer pinned
 * off, and an approach was faked by writing its hour into a copied snapshot). The season is played by the scripted talking player with every layer at its shipped default; each test
 * stops at a quiet moment of a played week (the HOH is crowned, nominations are next, nothing open, nothing due) and only flips the want's switch to read the movement intent.
 * The pure scale and the movement-share checks stay in tests/unit/wantMovement.test.ts. Roles only.
 */
type Pull = { target: string; weight: number; avoid: boolean };
const intentOf = (s: Stop, id: string): Pull[] | null => s.sess.movementIntentFor(id) as Pull[] | null;
const toward = (arr: Pull[] | null, t: string): number => arr?.find((p) => p.target === t)?.weight ?? 0;
const hohOf = (s: Stop): string | undefined => s.sess.live?.hoh;
/** A quiet moment before the nominations of a played week: the want of every non-HOH points at the HOH (a campaign or a plea). */
const beforeNoms = (s: Stop): boolean => {
  const g = s.sess.getGameState() as { daySchedule?: { due: boolean; next: string }; pending?: unknown; phase: string };
  return hohOf(s) !== undefined && !!g.daySchedule && !g.daySchedule.due && g.daySchedule.next === "nominations" && !g.pending && g.phase !== "premiere";
};
const others = (s: Stop): string[] => (s.sess.livingIds() as string[]).filter((id) => id !== PLAYER && id !== hohOf(s));
const offOn = (s: Stop, id: string): { off: Pull[] | null; on: Pull[] | null } => {
  s.sess.setWantMovementEnabled(false); // not as shipped: the off arm of the on/off read, switched back on below
  const off = intentOf(s, id);
  s.sess.setWantMovementEnabled(true);
  return { off, on: intentOf(s, id) };
};

describe("want-driven movement in a played season", () => {
  it("before the first ceremony the want is never read (flag on = flag off)", async () => {
    const at = await playUntil(5, () => true, { user: "wf-5" });
    const ids = at.sess.livingIds() as string[];
    const read = (on: boolean) => { at.sess.setWantMovementEnabled(on); return JSON.stringify(ids.map((id) => intentOf(at, id))); };
    // not as shipped: the off read is the comparison arm, switched back on after
    expect(read(true)).toBe(read(false));
    at.sess.setWantMovementEnabled(true);
  }, 120_000);

  it("flag ON: a non-HOH's pull toward the HOH is scaled up by its want, never lowered; the HOH's own intent is unchanged; most of the house leans toward the HOH (three seeds)", async () => {
    for (const at of await firstStops(3, beforeNoms, wfScan([3, 5, 11], "the moment before nominations"))) {
      const seed = at.seed;
      const hoh = hohOf(at)!;
      const { off: hohOff, on: hohOn } = offOn(at, hoh);
      expect(JSON.stringify(hohOn), "the HOH has no want to pursue").toBe(JSON.stringify(hohOff));
      let raised = 0;
      for (const id of others(at)) {
        const { off, on } = offOn(at, id);
        expect(toward(on, hoh), "a want never lowers an existing pull").toBeGreaterThanOrEqual(toward(off, hoh) - 1e-12);
        if (toward(on, hoh) > toward(off, hoh) + 1e-9) raised++;
      }
      expect(raised, `seed ${seed}: most of the house now leans toward the HOH`).toBeGreaterThan(others(at).length / 2);
    }
  }, 300_000);

  it("an approach spends the want: a houseguest who has just approached is back to exactly the flag-off pull, while the others still lean", async () => {
    const justApproached = (s: Stop): string[] => {
      const at = s.sess.live?.desireApproachedAt as Record<string, number> | undefined;
      const now = ((s.sess.live?.dayNumber ?? 1) - 1) * 24 + (s.sess.live?.nightDepth ?? 8);
      return others(s).filter((id) => at?.[id] !== undefined && Math.abs(at[id]! - now) < 1e-9);
    };
    const at = await firstStop((s) => beforeNoms(s) && justApproached(s).length > 0, wfScan(3));
    const hoh = hohOf(at)!;
    for (const id of justApproached(at)) {
      const { off, on } = offOn(at, id);
      expect(toward(on, hoh), "spent: no lean beyond the flag-off pull").toBeCloseTo(toward(off, hoh), 9);
    }
    const leaning = others(at).filter((id) => !justApproached(at).includes(id)).filter((id) => { const { off, on } = offOn(at, id); return toward(on, hoh) > toward(off, hoh) + 1e-9; });
    expect(leaning.length, "non-vacuous: the want is live for the houseguests who have not approached").toBeGreaterThan(0);
  }, 300_000);
});
