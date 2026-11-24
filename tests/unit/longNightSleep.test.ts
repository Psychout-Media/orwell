import { describe, it, expect } from "vitest";
import { restDeficitForDepth } from "../../src/engine/timeOfDay";
import { playerNightDeficit } from "../../src/engine/liveSeason";
import { bootPlayed, playNight } from "../support/longNightDriver";

/**
 * ORW-696 (B2-2 + B2-3): the double-eviction long night. UNIT: the double eviction is re-armed by hand at 12 houseguests (bootPlayed replaces the sealed plan), so it fires in week 4
 * (ORW-812: the same checks on a season whose own plan arms it are played in tests/uat/realPathLongNight.test.ts, the heavy lane). ADR 0006: nobody can turn in on that night, so
 * (B2-2) nobody in the house goes to bed during it, and (B2-3) the hours it forced awake are charged to no one: the player's bed stamp and every NPC's debt read the same waived night.
 * Roles only. The hidden rest numbers are read from internals here and never cross to a player surface.
 */
type Any = Record<string, any>;

/** Linger (own messages, the player's choice) up to `hour` just before the first eviction closes, then play the whole night. */
function playLate(seed: number, hour: number, onRow?: (s: Any, row: Any) => void): { s: Any; rows: Any[]; fired: boolean } {
  const s = bootPlayed(seed, true);
  let k = 0, started = false;
  const r = playNight(s, (row) => {
    if (row.twist !== "running" && row.beat === "eviction" && !started && hour > 0) {
      for (let i = 0; i < 80 && (s.live.nightDepth ?? 0) < hour; i++) s.noteMessage({ messageId: `l${k++}` });
    }
    if (row.twist === "running") started = true;
    onRow?.(s, row);
    return false;
  });
  return { s, rows: r.rows, fired: r.fired };
}

describe("ORW-696 the double-eviction long night (unit: the twist is armed by hand): nobody turns in, nobody pays for it", () => {
  it("B2-2: no houseguest is asleep at any point while the long night runs (an early sleeper stays up)", () => {
    for (const seed of [5, 7]) { // ORW-868: seed 11 (early sleepers whose bedtime falls inside the night) became a spectator seed with the cast-mean player stats, so seed 7 stands in
      let running = 0; const asleep: string[] = [];
      const { fired } = playLate(seed, 0, (s, row) => {
        if (row.twist !== "running") return;
        running++;
        const awake = s.awakeIds() as Set<string>;
        for (const id of s.live.active) if (!awake.has(id)) asleep.push(`${row.i}:${id}`);
      });
      expect(fired, `seed ${seed}`).toBe(true);
      expect(running).toBeGreaterThan(10);
      expect(asleep, `seed ${seed}: someone turned in during the long night`).toEqual([]);
    }
  });

  it("B2-3: a night that ran past midnight is waived for the player and the house alike", () => {
    const { s, fired } = playLate(5, 23);
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
    // Equal treatment: the player owes only their own pre-night lingering; the forced hours add nothing, and no NPC is charged any more than that same stamp implies (an early bed pays 0).
    const player = s.restDeficitOf("player") as number;
    const unwaived = restDeficitForDepth(endHour);
    expect(player, "less than the charge the late-hour stamp used to bank").toBeLessThan(unwaived);
    expect(playerNightDeficit(s.live), "tonight's debt is exactly the pre-night lingering").toBeCloseTo(restDeficitForDepth(startHour), 6);
    for (const id of s.live.active.filter((x: string) => x !== "player")) expect(s.restDeficitOf(id) as number, "an NPC's debt reads the same waived night end").toBeLessThanOrEqual(player + 1e-9);
  });

  it("B2-3 control: hours the player chooses to stay up AFTER the night still cost them", () => {
    const { s } = playLate(5, 23);
    for (let i = 0; i < 6; i++) s.noteMessage({ messageId: `after${i}` });
    const lingered = s.live.nightDepth as number;
    s.turnIn();
    expect(s.restDeficitOf("player") as number).toBeGreaterThanOrEqual(0);
    if (lingered > 29) expect(s.restDeficitOf("player") as number).toBeGreaterThan(0);
  });
});
