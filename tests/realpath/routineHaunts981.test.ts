import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { knowsRoutine } from "../../src/engine/routines";
import { type Stop, firstStop, wfScan } from "./playedSeason";

/**
 * ORW-981 / spec 0209: a routine brings a houseguest to the player. In a PLAYED season (the scripted talking player on the production runtime; nothing set by hand), a houseguest who has been in the room with
 * the player at this time of day on enough separate days leans toward the player at that time: the pull toward the player is stronger than the same houseguest's with the layer off, never weaker, and never
 * turns an avoid into a seek. A houseguest who has not learned the player's haunt is unchanged. Roles only.
 */
type Pull = { target: string; weight: number; avoid: boolean };
const pullOf = (s: Stop, id: string): Pull | undefined => (s.sess.movementIntentFor(id) as Pull[] | null)?.find((p) => p.target === PLAYER);
const learnedNow = (s: Stop): string[] => {
  const tod = s.sess.live?.timeOfDay as string | undefined;
  const haunts = (s.sess.live?.playerHaunts ?? {}) as Record<string, Record<string, number[]>>;
  return (s.sess.livingIds() as string[]).filter((id) => id !== PLAYER && Object.entries(haunts[id] ?? {}).some(([k, days]) => !!tod && k.startsWith(`${tod}:`) && knowsRoutine(days.length)));
};

/** The stop's precondition: the layer changes someone's movement intent right now (a learned houseguest with no avoid and a bond that lets them lean in). */
const leansNow = (s: Stop): boolean => learnedNow(s).some((id) => {
  s.sess.setRoutineHauntsEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
  const off = JSON.stringify(s.sess.movementIntentFor(id));
  s.sess.setRoutineHauntsEnabled(true);
  return JSON.stringify(s.sess.movementIntentFor(id)) !== off;
});

describe("a houseguest who knows where the player usually is leans toward them", () => {
  it("the pull is stronger with the layer on, never weaker, never a seek made of an avoid", async () => {
    const at = await firstStop(leansNow, wfScan([3, 5, 7, 11], "a time of day the player keeps and a houseguest has seen on three days"), { maxMessages: 1500 });
    const s = at.sess;
    const learned = learnedNow(at);
    const others = (s.livingIds() as string[]).filter((id) => id !== PLAYER && !learned.includes(id));
    let stronger = 0;
    for (const id of learned) {
      s.setRoutineHauntsEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
      const off = pullOf(at, id);
      s.setRoutineHauntsEnabled(true);
      const on = pullOf(at, id);
      if (off?.avoid) { expect(on?.avoid, "an avoid stays an avoid").toBe(true); expect(on?.weight).toBe(off.weight); continue; }
      if (on && (!off || on.weight > off.weight)) stronger++;
      if (off) expect(on!.weight, "never weaker").toBeGreaterThanOrEqual(off.weight);
    }
    expect(stronger, "positive control: someone leans toward the player").toBeGreaterThan(0);
    for (const id of others) {
      s.setRoutineHauntsEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
      const off = JSON.stringify(pullOf(at, id) ?? null);
      s.setRoutineHauntsEnabled(true);
      expect(JSON.stringify(pullOf(at, id) ?? null), "a houseguest who has not learned the player's haunt has the same pull toward the player").toBe(off);
    }
  }, 900_000);
});

/** The same layer for a houseguest's own routine: an onlooker who has seen where another houseguest keeps a routine at this time of day, on enough separate days, leans toward them. */
const learnedNpcHolder = (s: Stop): Array<[string, string]> => {
  const tod = s.sess.live?.timeOfDay as string | undefined;
  const seen = (s.sess.live?.npcRoutineSightings ?? {}) as Record<string, Record<string, Record<string, number[]>>>;
  const out: Array<[string, string]> = [];
  for (const id of s.sess.livingIds() as string[]) for (const [holder, byKey] of Object.entries(seen[id] ?? {})) {
    if (holder !== PLAYER && holder !== id && (s.sess.livingIds() as string[]).includes(holder) && Object.entries(byKey).some(([k, days]) => !!tod && k.startsWith(`${tod}:`) && knowsRoutine(days.length))) out.push([id, holder]);
  }
  return out;
};
const leansToNpcNow = (s: Stop): boolean => learnedNpcHolder(s).some(([id, holder]) => {
  s.sess.setRoutineHauntsEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
  const off = ((s.sess.movementIntentFor(id) as Pull[] | null) ?? []).find((p) => p.target === holder);
  s.sess.setRoutineHauntsEnabled(true);
  const on = ((s.sess.movementIntentFor(id) as Pull[] | null) ?? []).find((p) => p.target === holder);
  return !!on && (!off || on.weight > off.weight);
});

describe("the same holds between houseguests (parity with the player's haunts)", () => {
  it("an onlooker who knows another houseguest's routine at this time leans toward them, never weaker, an avoid stays an avoid", async () => {
    const at = await firstStop(leansToNpcNow, wfScan([3, 5, 7, 11], "an onlooker who has seen a houseguest keep a routine on three days"), { maxMessages: 1500 });
    const s = at.sess;
    let stronger = 0;
    for (const [id, holder] of learnedNpcHolder(at)) {
      s.setRoutineHauntsEnabled(false); // not as shipped: the off arm of the on/off read, switched back on right after
      const off = ((s.movementIntentFor(id) as Pull[] | null) ?? []).find((p) => p.target === holder);
      s.setRoutineHauntsEnabled(true);
      const on = ((s.movementIntentFor(id) as Pull[] | null) ?? []).find((p) => p.target === holder);
      if (off?.avoid) { expect(on?.avoid).toBe(true); expect(on?.weight).toBe(off.weight); continue; }
      if (off) expect(on!.weight).toBeGreaterThanOrEqual(off.weight);
      if (on && (!off || on.weight > off.weight)) stronger++;
    }
    expect(stronger, "positive control: someone leans toward a houseguest").toBeGreaterThan(0);
  }, 900_000);
});
