import { describe, it, expect } from "vitest";
import { restDeficitForDepth } from "../../src/engine/timeOfDay";
import { playerNightDeficit } from "../../src/engine/liveSeason";
import { bootNatural, playNight, type Any } from "../support/longNightPlay";

/**
 * ORW-696 (B2-2 + B2-3): the double-eviction long night, in a PLAYED season whose own sealed plan arms it (ORW-812: before, the plan was re-armed by hand at 12 houseguests). ADR 0006:
 * nobody can turn in on that night, so (B2-2) nobody in the house goes to bed during it, and (B2-3) the hours it forced awake are charged to no one. Seeds 8 and 29 deal a double
 * eviction at 9 houseguests left (about week 8), and each has an early sleeper whose ordinary bedtime falls inside that night; the player is still in the house when it fires. The hidden rest numbers are read from internals and never cross to a player surface.
 * HEAVY LANE (tests/uat/**, the `real-path` leg): about 45 seconds of play per season on the runner, four seasons. Roles only.
 */
function playLate(seed: number, hour: number, onRow?: (s: Any, row: Any) => void): { s: Any; fired: boolean } {
  const s = bootNatural(seed, true, `ln-natural-${seed}-on`);
  let k = 0, started = false;
  const r = playNight(s, (row) => {
    if (row.twist !== "running" && row.beat === "eviction" && !started && hour > 0 && s.live.active.length <= s.live.twistPlan.doubleEvictionAtActive + 1) {
      for (let i = 0; i < 80 && (s.live.nightDepth ?? 0) < hour; i++) s.noteMessage({ messageId: `l${k++}` }); // the player lingers (their own messages) before the night begins
    }
    if (row.twist === "running") started = true;
    onRow?.(s, row);
    return false;
  });
  return { s, fired: r.fired };
}

describe("ORW-696 the double-eviction long night in a played season: nobody turns in, nobody pays for it", () => {
  it("B2-2: no houseguest is asleep at any point while the long night runs, though on ordinary nights someone is asleep by those hours", () => {
    for (const seed of [8, 29]) {
      let running = 0, from = Infinity, to = -Infinity; const asleep: string[] = []; const ordinary: Array<{ hour: number; asleep: number }> = [];
      const { s, fired } = playLate(seed, 0, (s, row) => {
        const awake = s.awakeIds() as Set<string> | null;
        const down = awake ? (s.live.active as string[]).filter((id) => id !== "player" && !awake.has(id)) : [];
        if (row.twist === "running") { running++; from = Math.min(from, row.hour); to = Math.max(to, row.hour); for (const id of down) asleep.push(`${row.i}:${id}`); }
        else ordinary.push({ hour: row.hour, asleep: down.length });
      });
      expect(fired, `seed ${seed}`).toBe(true);
      expect(s.live.evictionOrder.includes("player"), "the player is in the house for the night").toBe(false);
      expect(running).toBeGreaterThan(10);
      expect(asleep, `seed ${seed}: someone turned in during the long night`).toEqual([]);
      expect(ordinary.some((o) => o.hour >= from && o.hour <= to && o.asleep > 0), `seed ${seed}: non-vacuous, an early sleeper is down by these hours on an ordinary night`).toBe(true);
    }
  }, 600_000);

  it("B2-3: a night that ran past midnight is waived for the player and the house alike", () => {
    const { s, fired } = playLate(8, 23);
    expect(fired).toBe(true);
    const endHour = s.live.nightDepth as number;
    expect(endHour, "the forced night crossed midnight").toBeGreaterThan(24);
    expect(s.live.longNightForcedHours, "the night's forced hours are recorded").toBeGreaterThan(2);
    const forced = s.live.longNightForcedHours as number;
    const v = s.turnIn(); // the player's own bedtime the moment the night ends
    expect(v.held).toBeUndefined();
    const startHour = endHour - forced;
    expect(s.live.lastSleepDepth, "the stamp is the hour the night began (the player's own lingering), not the hour it ended").toBeCloseTo(startHour, 6);
    expect(s.live.longNightForcedHours, "cleared once the night is slept").toBeUndefined();
    const player = s.restDeficitOf("player") as number;
    expect(player, "less than the charge the late-hour stamp used to bank").toBeLessThan(restDeficitForDepth(endHour));
    expect(playerNightDeficit(s.live), "tonight's debt is exactly the pre-night lingering").toBeCloseTo(restDeficitForDepth(startHour), 6);
    for (const id of s.live.active.filter((x: string) => x !== "player")) expect(s.restDeficitOf(id) as number, "an NPC's debt reads the same waived night end").toBeLessThanOrEqual(player + 1e-9);
  }, 600_000);

  it("B2-3 control: hours the player chooses to stay up AFTER the night still cost them", () => {
    const { s } = playLate(8, 23);
    for (let i = 0; i < 6; i++) s.noteMessage({ messageId: `after${i}` });
    const lingered = s.live.nightDepth as number;
    s.turnIn();
    expect(s.restDeficitOf("player") as number).toBeGreaterThanOrEqual(0);
    if (lingered > 29) expect(s.restDeficitOf("player") as number).toBeGreaterThan(0);
  }, 600_000);
});
