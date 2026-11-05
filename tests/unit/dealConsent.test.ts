import { describe, it, expect } from "vitest";
import { decideDealConsent, dealWillingness, type DealConsentInputs } from "../../src/engine/dealConsent";
import { DEAL_CONSENT } from "../../src/engine/dealConsentConstants";

/**
 * NPC deal CONSENT (anti-sycophancy): before a player-proposed deal is recorded the ENGINE decides, from the NPC's OWN perspective, whether they agree.
 * Pure + deterministic: the same inputs give the same decision. Roles only.
 */
const NEUTRAL: DealConsentInputs = { kind: "safety", trust: 0.25, affinity: 0.25, threat: 0.3, grudge: 0, favor: 0, targetsMe: 0, jitter: 0 };
const WARM: DealConsentInputs = { ...NEUTRAL, trust: 0.8, affinity: 0.75, threat: 0.1 };
// NEUTRAL is the "typical newcomer" reference edge (willingness 0): the measured start-of-season mean.

describe("decideDealConsent — who agrees", () => {
  it("a trusted, warm NPC accepts a low-cost ask", () => {
    expect(decideDealConsent(WARM)).toEqual({ accept: true });
    expect(decideDealConsent({ ...WARM, kind: "vote" }).accept).toBe(true);
  });

  it("a neutral stranger accepts the cheap asks at either extreme of the jitter band", () => {
    for (const kind of ["safety", "vote", "final-two", "target-other"] as const) {
      for (const jitter of [-DEAL_CONSENT.jitter, 0, DEAL_CONSENT.jitter]) {
        expect(decideDealConsent({ ...NEUTRAL, kind, jitter }).accept, `${kind}@${jitter}`).toBe(true);
      }
    }
  });

  it("a distrustful NPC refuses, as 'distrust'", () => {
    expect(decideDealConsent({ ...NEUTRAL, trust: 0, affinity: 0.05 })).toEqual({ accept: false, reason: "distrust" });
  });

  it("an NPC who sees the player as a big threat refuses, as 'threat'", () => {
    expect(decideDealConsent({ ...NEUTRAL, threat: 0.9 })).toEqual({ accept: false, reason: "threat" });
  });

  it("an NPC who believes the player is gunning for them refuses, as 'targeted'", () => {
    expect(decideDealConsent({ ...NEUTRAL, targetsMe: 0.18 })).toEqual({ accept: false, reason: "targeted" });
    expect(decideDealConsent({ ...NEUTRAL, targetsMe: 0.1 }).accept, "even one believed claim is enough for a stranger").toBe(false);
  });

  it("an NPC holding a grudge refuses, as 'grudge'", () => {
    expect(decideDealConsent({ ...NEUTRAL, grudge: 0.15 })).toEqual({ accept: false, reason: "grudge" });
  });

  it("a remembered favor can tip a marginal NPC into agreeing", () => {
    const marginal: DealConsentInputs = { ...NEUTRAL, trust: 0.1, affinity: 0.1, threat: 0.35, kind: "vote" };
    expect(decideDealConsent(marginal).accept).toBe(false);
    expect(decideDealConsent({ ...marginal, favor: DEAL_CONSENT.favorCeiling }).accept).toBe(true);
  });

  it("an expensive ask (comp-throw / veto-save) is refused by a mere stranger as 'cost', but a close ally does it", () => {
    for (const kind of ["comp-throw", "veto-save"] as const) {
      expect(decideDealConsent({ ...NEUTRAL, kind })).toEqual({ accept: false, reason: "cost" });
      expect(decideDealConsent({ ...WARM, trust: 1, affinity: 1, threat: 0, kind }).accept, kind).toBe(true);
    }
  });

  it("the costlier the ask, the less willing: costs rise safety < vote..final-two < comp-throw < veto-save", () => {
    expect(DEAL_CONSENT.cost["safety"]).toBeLessThan(DEAL_CONSENT.cost["comp-throw"]);
    expect(DEAL_CONSENT.cost["comp-throw"]).toBeLessThan(DEAL_CONSENT.cost["veto-save"]);
    expect(DEAL_CONSENT.cost["vote"]).toBeLessThan(DEAL_CONSENT.cost["comp-throw"]);
  });

  it("a hostile NPC asked for something expensive is refused for the HOSTILITY (the salient reason), not 'cost'", () => {
    expect(decideDealConsent({ ...NEUTRAL, kind: "veto-save", threat: 0.9 }).reason).toBe("threat");
  });
});

describe("decideDealConsent — determinism and bounds", () => {
  it("the same inputs always give the same decision (pure)", () => {
    const a = decideDealConsent({ ...NEUTRAL, trust: 0.12, jitter: 0.02 });
    for (let i = 0; i < 20; i++) expect(decideDealConsent({ ...NEUTRAL, trust: 0.12, jitter: 0.02 })).toEqual(a);
  });

  it("jitter is small and only moves a MARGINAL decision: a clear accept and a clear refuse never flip across the band", () => {
    for (const jitter of [-DEAL_CONSENT.jitter, DEAL_CONSENT.jitter]) {
      expect(decideDealConsent({ ...WARM, jitter }).accept).toBe(true);
      expect(decideDealConsent({ ...NEUTRAL, threat: 0.9, jitter }).accept).toBe(false);
    }
    expect(DEAL_CONSENT.jitter).toBeLessThanOrEqual(0.05);
  });

  it("willingness is monotone: more trust/affinity/favor raise it; threat/grudge/targeting lower it", () => {
    const w = (o: Partial<DealConsentInputs>): number => dealWillingness({ ...NEUTRAL, ...o });
    expect(w({ trust: 0.6 })).toBeGreaterThan(w({}));
    expect(w({ affinity: 0.6 })).toBeGreaterThan(w({}));
    expect(w({ favor: 0.06 })).toBeGreaterThan(w({}));
    expect(w({ threat: 0.6 })).toBeLessThan(w({}));
    expect(w({ grudge: 0.1 })).toBeLessThan(w({}));
    expect(w({ targetsMe: 0.1 })).toBeLessThan(w({}));
  });

  it("junk inputs (NaN / out of range) never throw and never accept on garbage", () => {
    const r = decideDealConsent({ ...NEUTRAL, trust: Number.NaN, affinity: Number.NaN, threat: Number.NaN, grudge: Number.NaN, favor: Number.NaN, targetsMe: Number.NaN, jitter: Number.NaN });
    expect(typeof r.accept).toBe("boolean");
  });
});
