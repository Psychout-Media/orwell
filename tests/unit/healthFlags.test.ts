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
    delete process.env.ORWELL_FLAGS_OFF;
    expect(GameSessionAdapter.timeOfDayEffective(), "the clock is a code default now (default flip)").toBe(true);
    GameSessionAdapter.setTimeOfDayEnabled(false); // the FE's setTimeOfDay push
    expect(GameSessionAdapter.timeOfDayEffective()).toBe(false);
  });

  it("the default flip: every flipped flag reports ON unset, OFF for 0/false/off, and ORWELL_FLAGS_OFF=1 forces them all OFF", () => {
    const FLIPPED = ["campaigns", "trajectories", "triggers", "secretPacing", "juryHouse", "seededTieSurfacing", "mythMaking",
      "showrunner", "compIntent", "voteDeduction", "timeOfDay", "dealDepth", "strategicCadence", "schemeTargets", "confessionalDepth",
      "npcDealOffers", "soulDepth", "compMechanicsPlus", "compMixed", "gossipDrift", "secretBarter", "playerDossier", "traitorsFury",
      "producerRead", "dealsWitnesses", "boothReceipts"];
    const NOT_FLIPPED = ["npcMemory", "multiNightFatigue"];
    for (const k of Object.keys(process.env)) if (k.startsWith("ORWELL_")) delete process.env[k];
    let f = bootFlagsFromEnv();
    for (const k of FLIPPED) expect(f[k], `${k} defaults ON`).toBe(true);
    for (const k of NOT_FLIPPED) expect(f[k], `${k} stays opt-in`).toBe(false);
    process.env.ORWELL_CAMPAIGNS = "0"; process.env.ORWELL_TIME_OF_DAY = "off"; process.env.ORWELL_JURY_HOUSE = "false";
    f = bootFlagsFromEnv();
    expect([f.campaigns, f.timeOfDay, f.juryHouse]).toEqual([false, false, false]);
    expect(f.triggers, "an explicit off on one flag does not touch the others").toBe(true);
    process.env = { ...saved }; process.env.ORWELL_FLAGS_OFF = "1";
    f = bootFlagsFromEnv();
    for (const k of FLIPPED) expect(f[k], `${k} off under ORWELL_FLAGS_OFF`).toBe(false);
  });
});
