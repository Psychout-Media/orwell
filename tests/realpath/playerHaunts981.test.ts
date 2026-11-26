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
  const seen = (s.sess.live?.npcRoutineSightings ?? {}) as Record<string, Record<string, Record<string, number[]>>>;
  return (s.sess.livingIds() as string[]).filter((id) => id !== PLAYER && Object.entries(seen[id]?.[PLAYER] ?? {}).some(([k, days]) => !!tod && k.startsWith(`${tod}:`) && knowsRoutine(days.length)));
};

/** The stop's precondition: the layer changes someone's movement intent right now (a learned houseguest with no avoid and a bond that lets them lean in). */
const leansNow = (s: Stop): boolean => learnedNow(s).some((id) => {
  s.sess.setPlayerHauntsEnabled(false);
  const off = JSON.stringify(s.sess.movementIntentFor(id));
  s.sess.setPlayerHauntsEnabled(true);
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
      s.setPlayerHauntsEnabled(false);
      const off = pullOf(at, id);
      s.setPlayerHauntsEnabled(true);
      const on = pullOf(at, id);
      if (off?.avoid) { expect(on?.avoid, "an avoid stays an avoid").toBe(true); expect(on?.weight).toBe(off.weight); continue; }
      if (on && (!off || on.weight > off.weight)) stronger++;
      if (off) expect(on!.weight, "never weaker").toBeGreaterThanOrEqual(off.weight);
    }
    expect(stronger, "positive control: someone leans toward the player").toBeGreaterThan(0);
    for (const id of others) {
      s.setPlayerHauntsEnabled(false);
      const off = JSON.stringify(s.movementIntentFor(id));
      s.setPlayerHauntsEnabled(true);
      expect(JSON.stringify(s.movementIntentFor(id)), "a houseguest who has not learned it is unchanged").toBe(off);
    }
  }, 900_000);
});
