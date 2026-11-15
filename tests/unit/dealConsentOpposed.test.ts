import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decideDealConsent, dealWillingness, type DealConsentInputs } from "../../src/engine/dealConsent";
import { drivePushFor } from "../../src/engine/campaigns";

/** ORW-87: deal consent reads the NPC's OWN drive/campaign against the player. Pure, no model, roles only. */
const NEUTRAL: DealConsentInputs = { kind: "safety", trust: 0.25, affinity: 0.25, threat: 0.3, grudge: 0, favor: 0, targetsMe: 0, jitter: 0 };
const WARM: DealConsentInputs = { ...NEUTRAL, trust: 0.8, affinity: 0.75, threat: 0.1 };
const PUSH = drivePushFor(undefined, "p", { goal: "evict", progress: 1 });

describe("deal consent: the NPC's own plan against the player", () => {
  it("absent or zero opposition is byte-identical", () => {
    expect(decideDealConsent({ ...WARM, opposed: 0 })).toEqual(decideDealConsent(WARM));
    expect(dealWillingness({ ...NEUTRAL, opposed: 0 })).toBe(dealWillingness(NEUTRAL));
  });
  it("an own evict campaign against the player lowers willingness and a stranger refuses, as 'opposed'", () => {
    expect(PUSH).toBeGreaterThan(0);
    expect(dealWillingness({ ...NEUTRAL, opposed: PUSH })).toBeLessThan(dealWillingness(NEUTRAL));
    expect(decideDealConsent({ ...NEUTRAL, kind: "vote", opposed: PUSH })).toEqual({ accept: false, reason: "opposed" });
  });
  it("a warm ally still accepts a cheap ask despite a campaign", () => {
    expect(decideDealConsent({ ...WARM, opposed: PUSH }).accept).toBe(true);
  });
  it("the adapter feeds it only in a played game, from the NPC's own plan", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src).toMatch(/live\.playedGame === true \? \{ opposed: this\.ownPushAgainstPlayer\(npcId\) \}/);
  });
});
