import { describe, it, expect, afterEach } from "vitest";
import { bootFlagsFromEnv } from "../../src/featureFlags";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * Audit (2026-11-01) — `/health` mis-reported two things:
 * (1) the "inverted" flags (ON unless explicitly "0") read OFF when unset, while the engine runs them ON;
 * (2) the in-game clock was read from the boot env only, so a runtime FE flip was invisible.
 */
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  GameSessionAdapter.setTimeOfDayEnabled(null);
});

describe("/health flag parsing matches what the engine actually runs", () => {
  it("inverted flags report ON when unset and OFF only for an explicit '0'", () => {
    delete process.env.ORWELL_TIME_PER_CONVERSATION;
    delete process.env.ORWELL_SOCIAL_FATIGUE;
    let f = bootFlagsFromEnv();
    expect(f.timePerConversation).toBe(true);
    expect(f.socialFatigue).toBe(true);
    process.env.ORWELL_TIME_PER_CONVERSATION = "0";
    process.env.ORWELL_SOCIAL_FATIGUE = "0";
    f = bootFlagsFromEnv();
    expect(f.timePerConversation).toBe(false);
    expect(f.socialFatigue).toBe(false);
  });

  it("the live clock state reflects a runtime flip, not just the boot env", () => {
    delete process.env.ORWELL_TIME_OF_DAY;
    expect(GameSessionAdapter.timeOfDayEffective()).toBe(false);
    GameSessionAdapter.setTimeOfDayEnabled(true); // the FE's setTimeOfDay push
    expect(GameSessionAdapter.timeOfDayEffective()).toBe(true);
  });
});
