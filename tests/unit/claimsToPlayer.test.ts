import { describe, it, expect } from "vitest";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { certaintyBand, decideTellToPlayer, presentedBand, sayable, tellChance, toPlayerKey, TO_PLAYER } from "../../src/engine/claimsToPlayer";

const H = "npc:1", S = "npc:2", T = "npc:3", P = "player";
const belief = (o: Partial<BeliefClaim>): BeliefClaim => ({ id: "b", holder: H, kind: "targets-me", subject: S, object: H, value: true, origin: "told", confidence: 0.8, week: 1, ...o });
const scene = { holder: H, player: P, trustInPlayer: 0.9, audience: 0, candor: 0.5, toldToday: false, alreadyTold: new Set<string>(), roll: 0 };

describe("claimsToPlayer (0151)", () => {
  it("bands are monotone in confidence and never take a truth argument", () => {
    expect([0.1, 0.5, 0.9].map(certaintyBand)).toEqual(["not-sure", "fairly-sure", "sure"]);
    expect(certaintyBand.length).toBe(1);
  });
  it("a presented band with no held belief spans the bands", () => {
    const seen = new Set([0, 0.3, 0.5, 0.9].map((r) => presentedBand(undefined, r)));
    expect(seen.size).toBe(3);
  });
  it("maps beliefs to honest claim kinds and leaves the rest unsaid", () => {
    expect(sayable(belief({}), H, P)).toMatchObject({ kind: "going-after", subject: S, object: H });
    expect(sayable(belief({ subject: P }), H, P)).toBeUndefined();
    expect(sayable(belief({ refuted: true }), H, P)).toBeUndefined();
    expect(sayable(belief({ kind: "heard-rumor", nature: "betrayal", object: T }), H, P)).toBeUndefined();
    expect(sayable(belief({ kind: "heard-rumor", nature: "talking-about", object: T }), H, P)).toMatchObject({ kind: "talking-about", object: T });
  });
  it("gates: trust, crowd, once a day, never the same belief twice", () => {
    expect(tellChance({ trustInPlayer: TO_PLAYER.trustGate - 0.01, audience: 0, candor: 1 })).toBe(0);
    expect(tellChance({ trustInPlayer: 1, audience: TO_PLAYER.crowdMax + 1, candor: 1 })).toBe(0);
    expect(decideTellToPlayer([belief({})], scene)?.band).toBe("sure");
    expect(decideTellToPlayer([belief({})], { ...scene, toldToday: true })).toBeUndefined();
    expect(decideTellToPlayer([belief({})], { ...scene, alreadyTold: new Set([toPlayerKey("going-after", S, H)]) })).toBeUndefined();
    expect(decideTellToPlayer([belief({})], { ...scene, roll: 0.999 })).toBeUndefined();
  });
  it("picks the surest, then freshest belief", () => {
    const d = decideTellToPlayer([belief({ id: "a", subject: T, confidence: 0.3 }), belief({ id: "b", confidence: 0.7 })], scene);
    expect(d?.belief.subject).toBe(S);
  });
});

describe("slice 3 kinds are sayable (0153 voted-against / voted-to-keep)", () => {
  const mk = (kind: string, subject: string, object: string | undefined, nature?: string) => ({ id: "h|b", holder: "h", kind, subject, ...(object ? { object } : {}), ...(nature ? { nature } : {}), value: true, origin: "told", confidence: 0.7, week: 1 } as never);
  it("a held voted-against-me is said as the subject having voted to evict the speaker", () => {
    expect(sayable(mk("voted-against-me", "x", undefined), "h", "player")).toMatchObject({ kind: "voted-against", subject: "x", object: "h" });
  });
  it("a rumor about someone else's vote is said as that vote", () => {
    expect(sayable(mk("heard-rumor", "x", "y", "voted-against"), "h", "player")).toMatchObject({ kind: "voted-against", subject: "x", object: "y" });
    expect(sayable(mk("heard-rumor", "x", "y", "voted-to-keep"), "h", "player")).toMatchObject({ kind: "voted-to-keep", subject: "x", object: "y" });
  });
});
