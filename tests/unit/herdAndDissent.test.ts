import { describe, it, expect } from "vitest";
import { HERD, dissentMove, heardDissenters, herdPull, herdVoices } from "../../src/engine/houseNorms";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { voteChoice } from "../../src/engine/liveSeason";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** Feature 0180 part 2 - bandwagons and dissent. Roles only: a voter, nominees (n1, n2), houseguests heard of (s1..s3), the evictee, the survivor. */
const rumor = (holder: string, subject: string, object: string, nature: string, week = 3, extra: Partial<BeliefClaim> = {}): BeliefClaim =>
  ({ id: `${holder}|heard-rumor|${subject}|${object}|${week}|${nature}`, holder, kind: "heard-rumor", subject, object, nature, value: true, origin: "told", confidence: 0.7, week, ...extra }) as BeliefClaim;

describe("the herd (houseNorms.ts)", () => {
  it("counts distinct houseguests heard going after each nominee this week; never the voter, a nominee, a refuted or an old belief", () => {
    const held = [
      rumor("v", "s1", "n1", "going-after"), rumor("v", "s1", "n1", "going-after"), rumor("v", "s2", "n1", "going-after"),
      rumor("v", "s3", "n2", "going-after"), rumor("v", "v", "n2", "going-after"), rumor("v", "n2", "n1", "going-after"),
      rumor("v", "s3", "n1", "going-after", 2), rumor("v", "s2", "n2", "going-after", 3, { refuted: true }), rumor("v", "s3", "n1", "talking-about"),
    ];
    expect(herdVoices(held, "v", ["n1", "n2"], 3)).toEqual([2, 1]);
  });
  it("pulls toward the side the house is on, needs enough voices, and the culture's alliance-size dial scales it", () => {
    expect(herdPull([1, 0], 0, 1)).toBe(0); // one voice is not a herd
    expect(herdPull([3, 0], 0, 1)).toBeCloseTo(HERD.weight, 12);
    expect(herdPull([3, 0], 1, 1)).toBeCloseTo(-HERD.weight, 12);
    expect(herdPull([2, 2], 0, 1)).toBe(0); // a split house pulls nowhere
    expect(herdPull([3, 0], 0, 1.5)).toBeGreaterThan(herdPull([3, 0], 0, 1));
  });
  it("tips a close call in the real vote, and never overturns a voter with a strong reason of their own", () => {
    const edge = (threat: number, trust = 0.5, affinity = 0.5) => ({ trust, affinity, threat, reliability: 0.5 });
    const edges: Record<string, ReturnType<typeof edge>> = { "v|n1": edge(0.30), "v|n2": edge(0.32), "n1|v": edge(0.1), "n2|v": edge(0.1) };
    const rel = { edge: (a: string, b: string) => edges[`${a}|${b}`] ?? edge(0.1), bondStrength: (a: string, b: string) => { const e = edges[`${a}|${b}`] ?? edge(0.1); return (e.trust + e.affinity) / 2; } };
    const ctx = (herd?: number) => ({ rel, player: PLAYER, ...(herd !== undefined ? { herdFor: (n: string) => (n === "n1" ? herd : -herd) } : {}) }) as never;
    expect(voteChoice("v", ["n1", "n2"], ctx())).toBe("n2"); // on their own, a close call toward n2
    expect(voteChoice("v", ["n1", "n2"], ctx(HERD.weight))).toBe("n1"); // the house is going after n1: they join it
    edges["v|n2"] = edge(0.9);
    expect(voteChoice("v", ["n1", "n2"], ctx(HERD.weight))).toBe("n2"); // a strong reason of their own holds
  });
});

describe("dissent noticed (houseNorms.ts)", () => {
  it("finds who the holder heard voted the other way this week: kept the evictee, or voted against the survivor", () => {
    const held = [rumor("h", "d1", "e", "voted-to-keep"), rumor("h", "d2", "s", "voted-against"), rumor("h", "x", "e", "voted-against"), rumor("h", "d3", "e", "voted-to-keep", 2)];
    expect(heardDissenters(held, "h", "e", "s", 3)).toEqual(["d1", "d2"]);
  });
  it("a split vote singles no one out; a lone dissent in a blowout costs the most", () => {
    expect(dissentMove(4, 7).affinity).toBe(0);
    const lone = dissentMove(6, 7), lopsided = dissentMove(5, 7);
    expect(lone.affinity).toBeCloseTo(HERD.dissentAffinity, 12);
    expect(lopsided.affinity).toBeLessThan(0);
    expect(lopsided.affinity).toBeGreaterThan(lone.affinity);
  });
});

describe("dissent noticed, in the live adapter (the player in both directions)", () => {
  function setup(seed: number, dissenterIsPlayer: boolean) {
    const sb = new GameSessionRegistry().sandboxFor(`dissent-${seed}-${dissenterIsPlayer}`);
    sb.session.setHouseNormsEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const seam = sb.session as unknown as {
      live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]>; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> };
      rel: { edge(a: string, b: string): { affinity: number; trust: number } }; foldDissentOvernight(): void;
    };
    seam.live.playedGame = true;
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const [holder, survivor, v2, v3, v4, other] = npcs;
    const dissenter = dissenterIsPlayer ? PLAYER : other!;
    const evictee = "npc:evicted";
    seam.live.voteRecord = [{ week: seam.live.week, evictee, voteOf: { [holder!]: evictee, [v2!]: evictee, [v3!]: evictee, [v4!]: evictee, [dissenter]: survivor! } }];
    seam.live.beliefs = { ...(seam.live.beliefs ?? {}), [holder!]: [rumor(holder!, dissenter, evictee, "voted-to-keep", seam.live.week)] };
    return { seam, holder: holder!, dissenter };
  }
  for (const dissenterIsPlayer of [false, true]) {
    it(`a majority voter who heard of a lone dissent cools on ${dissenterIsPlayer ? "the player" : "the houseguest"}, once`, () => {
      const { seam, holder, dissenter } = setup(19, dissenterIsPlayer);
      const before = { ...seam.rel.edge(holder, dissenter) };
      seam.foldDissentOvernight();
      const after = { ...seam.rel.edge(holder, dissenter) };
      expect(after.affinity).toBeLessThan(before.affinity);
      seam.foldDissentOvernight();
      expect(seam.rel.edge(holder, dissenter).affinity).toBeCloseTo(after.affinity, 12);
    });
  }
});
