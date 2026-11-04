import { describe, it, expect } from "vitest";
import { perceivedSupport, believedMargin, inDoubt, VOTE_ESTIMATE } from "../../src/engine/voteEstimate";

/**
 * B5 / #2017 slice 1 (design S3, vote counting / whip). An NPC estimates the upcoming vote from its PERCEIVED reads of the other voters, with error scaled by personality
 * (`overconfidence`): a confident NPC has narrow error bars and SYSTEMATICALLY under-estimates dissent. It campaigns only when the believed margin is inside a doubt band. Pure +
 * deterministic: the caller supplies the (seeded) per-voter noise draws. Wiring into campaigns is slice 2. Roles only.
 */
describe("perceivedSupport", () => {
  it("is the true probability when there is no error source (neutral personality, zero noise)", () => {
    expect(perceivedSupport(0.6, 0, 0)).toBeCloseTo(0.6, 9);
  });
  it("an overconfident estimator systematically over-reads support (under-estimates dissent)", () => {
    for (const p of [0.1, 0.4, 0.7]) expect(perceivedSupport(p, 0.9, 0)).toBeGreaterThan(perceivedSupport(p, 0.1, 0));
  });
  it("noise matters less to an overconfident estimator (narrow error bars)", () => {
    const spread = (oc: number) => Math.abs(perceivedSupport(0.5, oc, 1) - perceivedSupport(0.5, oc, -1));
    expect(spread(0.9)).toBeLessThan(spread(0.1));
  });
  it("is always a probability", () => {
    for (const p of [0, 0.5, 1]) for (const oc of [0, 0.5, 1]) for (const n of [-1, 0, 1]) {
      const v = perceivedSupport(p, oc, n);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("believedMargin / inDoubt", () => {
  const voters = [0.9, 0.8, 0.2, 0.5, 0.5];   // true P(votes to evict the target) for 5 voters
  it("the margin is believed votes minus the majority line, deterministic for the same noise", () => {
    const noise = [0, 0, 0, 0, 0];
    expect(believedMargin(voters, 0, noise)).toBeCloseTo(0.9 + 0.8 + 0.2 + 0.5 + 0.5 - 5 / 2, 9);
    expect(believedMargin(voters, 0, noise)).toBe(believedMargin(voters, 0, noise));
  });
  it("an overconfident NPC believes a wider margin than the truth", () => {
    expect(believedMargin(voters, 0.9, [0, 0, 0, 0, 0])).toBeGreaterThan(believedMargin(voters, 0, [0, 0, 0, 0, 0]));
  });
  it("campaigns only inside the doubt band", () => {
    expect(inDoubt(0.1)).toBe(true);
    expect(inDoubt(-VOTE_ESTIMATE.doubtBand)).toBe(true);
    expect(inDoubt(VOTE_ESTIMATE.doubtBand + 0.01)).toBe(false);
    expect(inDoubt(-(VOTE_ESTIMATE.doubtBand + 0.01))).toBe(false);
  });
  it("the band grows with the number of voters", () => {
    expect(inDoubt(VOTE_ESTIMATE.doubtBand + 0.5, 0)).toBe(false);
    expect(inDoubt(VOTE_ESTIMATE.doubtBand + 0.5, 10)).toBe(true);
  });
  it("a missing noise draw is treated as zero (never NaN)", () => {
    expect(Number.isFinite(believedMargin(voters, 0.5, []))).toBe(true);
  });
});

import { formCampaigns, CAMPAIGN } from "../../src/engine/campaigns";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

describe("campaign gating (slice 2)", () => {
  const actors = [{ id: "npc:1", threats: [{ toward: "npc:2", threat: CAMPAIGN.threatThreshold + 0.2 }], allies: [], persuasiveness: 0.9 }];
  it("an evict campaign forms when no gate is supplied (byte-identical) or the count is in doubt", () => {
    expect(formCampaigns(actors, { rng: new SeededRandom(1), beat: 1 }).length).toBe(1);
    expect(formCampaigns(actors, { rng: new SeededRandom(1), beat: 1, worthWorking: () => true }).length).toBe(1);
  });
  it("it does NOT form when the estimator believes the count is already decided", () => {
    expect(formCampaigns(actors, { rng: new SeededRandom(1), beat: 1, worthWorking: () => false }).length).toBe(0);
  });
  it("the gate only applies to evict campaigns (an alliance build is never gated by the vote count)", () => {
    const ally = [{ id: "npc:1", threats: [], allies: [{ toward: "npc:3", affinity: CAMPAIGN.allyThreshold + 0.2 }], persuasiveness: 0.9 }];
    expect(formCampaigns(ally, { rng: new SeededRandom(1), beat: 1, worthWorking: () => false }).length).toBe(1);
  });
});

import { GameSessionRegistry } from "../../src/composition/registry";

describe("adapter gate (slice 2, flag ORWELL_VOTE_COUNT)", () => {
  function sess() {
    const sb = new GameSessionRegistry().sandboxFor(`vc-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    const ids = [...sb.session.livingIds()].filter((i) => i !== "player");
    return { sb, ids };
  }
  type Gate = { voteStillInDoubt(a: string, t: string): boolean };
  it("is deterministic for the same (actor, target, week)", () => {
    const { sb, ids } = sess();
    const g = sb.session as unknown as Gate;
    expect(g.voteStillInDoubt(ids[0]!, ids[1]!)).toBe(g.voteStillInDoubt(ids[0]!, ids[1]!));
  });
  it("a fresh, neutral house is in doubt (the actor still has a count to work)", () => {
    const { sb, ids } = sess();
    const g = sb.session as unknown as Gate;
    expect(g.voteStillInDoubt(ids[0]!, ids[1]!)).toBe(true);
  });
});
