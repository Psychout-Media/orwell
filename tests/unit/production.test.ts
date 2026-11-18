import { describe, it, expect } from "vitest";
import { PRODUCTION, hostMayAsk, hostQuestions, comesBack, diaryCallSeen, pushbacks, type HostFact } from "../../src/engine/production";

/** Theme C foundation (ORW-666): production as a character. Roles only. */
const EVICTEE = "npc:evictee", OTHER = "npc:other", PLAYER = "player", TARGET = "npc:target";
const f = (o: Partial<HostFact>): HostFact => ({ id: "f", actor: OTHER, public: true, hidden: false, drama: 0.5, week: 1, ...o });

describe("C1: the host asks only about what the house saw and the evictee's own choices", () => {
  it("never a hidden fact; a private act only if it is the evictee's own", () => {
    expect(hostMayAsk(f({ hidden: true, actor: EVICTEE }), EVICTEE)).toBe(false);
    expect(hostMayAsk(f({ public: false }), EVICTEE)).toBe(false);
    expect(hostMayAsk(f({ public: false, actor: EVICTEE }), EVICTEE)).toBe(true);
    expect(hostMayAsk(f({}), EVICTEE)).toBe(true);
  });
  it("own choices first, then drama, capped", () => {
    const qs = hostQuestions([f({ id: "a", drama: 0.9 }), f({ id: "b", actor: EVICTEE, drama: 0.1 }), f({ id: "c", hidden: true, drama: 1 }), f({ id: "d", drama: 0.6 }), f({ id: "e", drama: 0.2 })], EVICTEE);
    expect(qs.map((q) => q.id)).toEqual(["b", "a", "d"]);
    expect(qs.length).toBe(PRODUCTION.maxHostQuestions);
  });
});

describe("C2: a Diary Room call is visible, its content is not", () => {
  it("the house sees who, whether it was long, and the face they come back with", () => {
    expect(comesBack(0.5, 0.5 + PRODUCTION.moodShows)).toBe("lighter");
    expect(comesBack(0.5, 0.5 - PRODUCTION.moodShows)).toBe("heavier");
    expect(comesBack(0.5, 0.55)).toBe("same");
    const seen = diaryCallSeen(PLAYER, 3, PRODUCTION.longCallMinutes, 0.5, 0.3);
    expect(seen).toEqual({ who: PLAYER, day: 3, long: true, comesBack: "heavier" });
    expect(Object.keys(seen)).not.toContain("content");
  });
});

describe("C3: the producer pushes back only on the player's own said-versus-did", () => {
  it("a promise of safety followed by a nomination of the same person is a pushback; acts against others, or before the promise, are not", () => {
    const said = [{ claimId: "s1", to: TARGET, promise: "safe" as const, week: 2 }];
    expect(pushbacks(said, [{ eventId: "e1", act: "nominated", target: TARGET, week: 2 }])).toHaveLength(1);
    expect(pushbacks(said, [{ eventId: "e2", act: "nominated", target: OTHER, week: 2 }])).toHaveLength(0);
    expect(pushbacks(said, [{ eventId: "e3", act: "nominated", target: TARGET, week: 1 }])).toHaveLength(0);
    expect(pushbacks([{ claimId: "s2", to: TARGET, promise: "vote-with", week: 1 }], [{ eventId: "e4", act: "nominated", target: TARGET, week: 1 }])).toHaveLength(0);
  });
  it("newest first, capped", () => {
    const said = ["a", "b", "c"].map((t, i) => ({ claimId: `s${i}`, to: `npc:${t}`, promise: "deal" as const, week: 1 }));
    const did = ["a", "b", "c"].map((t, i) => ({ eventId: `e${i}`, act: "broke-deal" as const, target: `npc:${t}`, week: 1 + i }));
    const p = pushbacks(said, did);
    expect(p).toHaveLength(PRODUCTION.maxPushbacks);
    expect(p[0]!.did.week).toBe(3);
  });
});
