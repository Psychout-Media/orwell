import { describe, it, expect } from "vitest";
import {
  phaseForHour, bedtimeHourFor, sleepDeficitForBedHour, socialSwayScale, SOCIAL_SWAY_FLOOR,
  accrueFatigue, combinedRestDeficit, WAKE_HOUR, DAY_END_HOUR,
} from "../../src/engine/timeOfDay";
import { CLOCK } from "../../src/engine/sleepConstants";
import { advanceClock, advanceClockPerMessage, playerTurnIn, playerRestDeficit, npcRestDeficit } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * 0066 — the 24-hour clock + the graded sleep economy (#1125). The hidden `nightDepth` field carries the
 * clock-HOUR (8..32); the public `timeOfDay` is PROJECTED from it via `phaseForHour`. Everything is gated:
 * with no clock running (no `nightDepth` / `lastSleepDepth`) every read is 0 ⇒ byte-identical to the
 * pre-feature model. No rng: a bedtime is DERIVED deterministically, never rolled. Roles only.
 */

describe("phaseForHour — projects the clock-hour onto the public 5 phases (monotonic)", () => {
  it("8 = morning, 24+ = late-night, and the projection never goes backwards through the day", () => {
    expect(phaseForHour(WAKE_HOUR)).toBe("morning");
    expect(phaseForHour(24)).toBe("late-night");
    expect(phaseForHour(0)).toBe("morning");   // clamped below the wake
    expect(phaseForHour(40)).toBe("late-night"); // clamped above the day
    let last = -1;
    const order = ["morning", "afternoon", "evening", "night", "late-night"];
    for (let h = WAKE_HOUR; h < DAY_END_HOUR; h += 0.25) {
      const idx = order.indexOf(phaseForHour(h));
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });
});

describe("bedtimeHourFor — chronotype is its OWN axis, deterministic, byte-stable (clock-hours)", () => {
  it("is in range, and a social houseguest beds LATER (post-midnight) than a comp-focused one", () => {
    const owl = bedtimeHourFor({ physical: 0.2, social: 0.9 });
    const lark = bedtimeHourFor({ physical: 0.9, social: 0.2 });
    expect(owl).toBeGreaterThan(lark);
    expect(lark).toBeLessThan(CLOCK.midnightHour);   // a lark beds before midnight
    expect(owl).toBeGreaterThan(CLOCK.midnightHour); // an owl beds after midnight
    for (const s of [{ physical: 0, social: 1 }, { physical: 1, social: 0 }, { physical: 0.5, social: 0.5 }]) {
      const h = bedtimeHourFor(s);
      expect(h).toBeGreaterThanOrEqual(21);
      expect(h).toBeLessThanOrEqual(26);
    }
  });

  it("the per-id variation is DETERMINISTIC (same id ⇒ same) and SPREADS similar-stat houseguests apart", () => {
    const stats = { physical: 0.5, social: 0.5 };
    expect(bedtimeHourFor(stats, "hg-A")).toBe(bedtimeHourFor(stats, "hg-A")); // no rng — stable
    const a = bedtimeHourFor(stats, "hg-A");
    const b = bedtimeHourFor(stats, "hg-B");
    expect(a).not.toBe(b); // two identical-stat houseguests still differ (its own axis)
    expect(bedtimeHourFor(stats)).not.toBe(a); // omitting the id is the legacy pure-stats shape
  });
});

describe("sleepDeficitForBedHour — graded, only past midnight (no normal-night tax)", () => {
  it("0 through midnight (≤24), then ramps to 1 at the 8am wake, monotonically", () => {
    expect(sleepDeficitForBedHour(20)).toBe(0);   // 8pm
    expect(sleepDeficitForBedHour(CLOCK.midnightHour)).toBe(0); // midnight is free
    expect(sleepDeficitForBedHour(26)).toBeGreaterThan(0);      // 2am
    expect(sleepDeficitForBedHour(DAY_END_HOUR)).toBeCloseTo(1); // up to the bitter end
    let prev = -1;
    for (let h = WAKE_HOUR; h <= DAY_END_HOUR; h += 0.5) {
      const v = sleepDeficitForBedHour(h);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("advanceClock — advances the clock-hour, projects the phase, wraps at the 8am wake", () => {
  it("rolls over several beats (no whole-phase lurch); a night only the BEATS carried banks nothing, a night the player lingered through banks the max deficit", () => {
    const run = (linger: boolean) => {
      const s = {} as LiveSeasonState;
      advanceClock(s); // first beat starts the morning wake
      expect(s.timeOfDay).toBe("morning");
      expect(s.nightDepth).toBe(WAKE_HOUR);
      let beats = 0;
      while (s.timeOfDay !== "late-night" && beats < 50) { advanceClock(s); beats++; }
      expect(beats).toBeGreaterThan(3); // a phase takes MORE than one beat (the cadence: ~3h/beat over 4h phases)
      if (linger) advanceClockPerMessage(s, 5 / 60); // the player talks on into the night (their own choice)
      // run out the night without the player turning in ⇒ wrap to the 8am wake
      for (let i = 0; i < 50 && s.nightDepth !== WAKE_HOUR; i++) advanceClock(s);
      expect(s.timeOfDay).toBe("morning");
      return s;
    };
    // deliberate re-pin (ORW-322, Coordinator ruling on #2574: debt only from CHOOSING to stay up): ceremony-beat hours are presentation, so a wrap they alone cause banks nothing...
    const beatsOnly = run(false);
    expect(beatsOnly.lastSleepDepth).toBeUndefined();
    expect(playerRestDeficit(beatsOnly)).toBe(0);
    // ...while a night the player lingered through still banks the full "running on empty".
    const lingered = run(true);
    expect(lingered.lastSleepDepth).toBe(DAY_END_HOUR);
    expect(playerRestDeficit(lingered)).toBeCloseTo(1);
  });

  it("the player's bedtime lever grades the deficit by the clock-hour they were up to", () => {
    const early = { nightDepth: 22, evictionOrder: [] } as unknown as LiveSeasonState; // bedded 10pm
    playerTurnIn(early, "player");
    expect(early.timeOfDay).toBe("morning");
    expect(playerRestDeficit(early)).toBe(0); // before midnight ⇒ rested

    const late = { nightDepth: 27, evictionOrder: [] } as unknown as LiveSeasonState; // up to 3am
    playerTurnIn(late, "player");
    expect(playerRestDeficit(late)).toBeGreaterThan(0); // past midnight ⇒ a real cost
  });
});

describe("socialSwayScale — a tired houseguest sways the house LESS (effectiveness, floored)", () => {
  it("is 1 when rested (byte-identical), drops monotonically, and never below the floor", () => {
    expect(socialSwayScale(0)).toBe(1); // rested ⇒ no scaling ⇒ the off-screen fold is unchanged
    expect(socialSwayScale(1)).toBe(SOCIAL_SWAY_FLOOR);
    expect(socialSwayScale(2)).toBe(SOCIAL_SWAY_FLOOR);  // clamped
    let prev = 2;
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const v = socialSwayScale(d);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(SOCIAL_SWAY_FLOOR);
      prev = v;
    }
  });
});

describe("multi-night fatigue — a STRING of late nights compounds; a rested night recovers", () => {
  it("accrueFatigue stacks consecutive late nights toward 1 and decays when rested (bounded)", () => {
    const n1 = accrueFatigue(0, 0.5);
    const n2 = accrueFatigue(n1, 0.5);
    const n3 = accrueFatigue(n2, 0.5);
    expect(n2).toBeGreaterThan(n1);
    expect(n3).toBeGreaterThan(n2);
    expect(n3).toBeLessThanOrEqual(1);
    expect(accrueFatigue(1, 1)).toBe(1); // saturates
    const recovered = accrueFatigue(n3, 0);
    expect(recovered).toBeLessThan(n3);
    expect(recovered).toBeGreaterThanOrEqual(0);
  });

  it("combinedRestDeficit adds the meter on top of the immediate deficit, bounded and monotonic", () => {
    expect(combinedRestDeficit(0, 0)).toBe(0);
    expect(combinedRestDeficit(0.3, 0)).toBe(0.3);
    expect(combinedRestDeficit(0.3, 0.8)).toBeGreaterThan(0.3);
    expect(combinedRestDeficit(1, 1)).toBe(1);
    expect(combinedRestDeficit(0, 0.5)).toBeGreaterThan(combinedRestDeficit(0, 0.2));
  });
});

describe("gated OFF ⇒ byte-identical: with no clock running every sleep read is 0", () => {
  it("an absent clock means zero deficit for the player and every NPC", () => {
    const dormant = {} as LiveSeasonState; // no nightDepth / lastSleepDepth — the calibration spine
    expect(playerRestDeficit(dormant)).toBe(0);
    expect(npcRestDeficit(dormant, { physical: 0.2, social: 0.9 }, "owl")).toBe(0);
    expect(npcRestDeficit(dormant, { physical: 0.9, social: 0.2 }, "lark")).toBe(0);
  });
});
