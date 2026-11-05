import { describe, it, expect, afterEach } from "vitest";
import { bootFlagsFromEnv, FEATURE_FLAGS } from "../../src/featureFlags";
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
    process.env.ORWELL_FLAGS_OFF = "1";
    GameSessionAdapter.setTimeOfDayEnabled(true); // the FE re-pushes ON on every boot...
    expect(GameSessionAdapter.timeOfDayEffective(), "...but the diagnostic ORWELL_FLAGS_OFF=1 profile wins").toBe(false);
    delete process.env.ORWELL_FLAGS_OFF;
    GameSessionAdapter.setTimeOfDayEnabled(null);
    GameSessionAdapter.setTimeOfDayEnabled(false); // the FE's setTimeOfDay push
    expect(GameSessionAdapter.timeOfDayEffective()).toBe(false);
  });

  it("the default flip: every default-on flag (derived from the registry) reports ON unset, OFF for each of 0/false/off, and ORWELL_FLAGS_OFF=1 forces all OFF", () => {
    const FLIPPED = FEATURE_FLAGS.filter((d) => d.parser === "defaultOn");
    expect(FLIPPED.length, "the registry carries the 37 flipped flags").toBe(37);
    const NOT_FLIPPED = ["advanceGate", "multiNightFatigue", "assurances", "voteCount", "gossipCopresence", "vetoMemory", "npcTells", "tellReactions", "moodVeto", "moodApproach", "moodDeal", "driftFix", "driveDecisions", "moodCampaign", "npcMemorySpeech", "forgiveness", "approachMemory", "memoryPromises", "hcMemory", "dealNoms", "campaignMemory", "lobbying", "morningApproach"];
    for (const k of Object.keys(process.env)) if (k.startsWith("ORWELL_")) delete process.env[k];
    let f = bootFlagsFromEnv();
    for (const d of FLIPPED) expect(f[d.key], `${d.key} defaults ON`).toBe(true);
    for (const k of NOT_FLIPPED) expect(f[k], `${k} stays opt-in`).toBe(false);
    for (const d of FLIPPED) {
      for (const off of ["0", "false", "off", "OFF", " 0 "]) {
        process.env[d.envKey] = off;
        const g = bootFlagsFromEnv();
        expect(g[d.key], `${d.envKey}=${JSON.stringify(off)} turns ${d.key} off`).toBe(false);
        expect(Object.entries(g).filter(([k, v]) => !v && k !== d.key).map(([k]) => k).sort(), "no other flag moves").toEqual(NOT_FLIPPED.slice().sort());
        delete process.env[d.envKey];
      }
    }
    process.env.ORWELL_FLAGS_OFF = "1";
    f = bootFlagsFromEnv();
    for (const d of FLIPPED) expect(f[d.key], `${d.key} off under ORWELL_FLAGS_OFF`).toBe(false);
  });

  it("reactiveTwists is reported on /health: ON by default (PO ruling 2026-11-03), OFF for 0/false/off, and forced OFF by ORWELL_FLAGS_OFF=1", () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("ORWELL_")) delete process.env[k];
    expect(bootFlagsFromEnv().reactiveTwists).toBe(true);
    for (const v of ["0", "false", "off"]) {
      process.env.ORWELL_REACTIVE_TWISTS = v;
      expect(bootFlagsFromEnv().reactiveTwists, `ORWELL_REACTIVE_TWISTS=${JSON.stringify(v)}`).toBe(false);
    }
    delete process.env.ORWELL_REACTIVE_TWISTS;
    process.env.ORWELL_FLAGS_OFF = "1";
    expect(bootFlagsFromEnv().reactiveTwists).toBe(false);
  });
});
