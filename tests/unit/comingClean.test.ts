import { describe, it, expect } from "vitest";
import { COMING_CLEAN, confessable, confessionTrustDrop, loopInTrustGain, catchRisk, confessChance, versionsAbout, type CleanAct, type CleanClaim } from "../../src/engine/comingClean";
import { caughtLieTrustDrop } from "../../src/engine/caughtLies";

/** 0203 (ORW-646) foundation: the pure rules. Roles only (a liar, two listeners, an ally, a subject). */
const L = "npc:liar", A = "npc:a", B = "npc:b", ALLY = "npc:ally", S = "npc:subject";
const lie = (id: string, listener: string, kind = "going-after"): CleanClaim => ({ id, speaker: L, listener, kind, subject: S, object: listener, isTrue: false });

describe("0203 foundation: coming clean", () => {
  it("confessing first costs less than being caught, and a lie can be confessed once per listener, never after it was caught, never if it was true", () => {
    expect(confessionTrustDrop()).toBeLessThan(caughtLieTrustDrop(1));
    expect(confessionTrustDrop()).toBeCloseTo(COMING_CLEAN.confessShare * caughtLieTrustDrop(1));
    const c = lie("c1", A);
    expect(confessable(c, new Set(), [])).toBe(true);
    expect(confessable(c, new Set(["c1"]), [])).toBe(false);
    expect(confessable({ ...c, isTrue: true }, new Set(), [])).toBe(false);
    const acts: CleanAct[] = [{ kind: "confess", by: L, to: A, claimId: "c1", week: 1 }];
    expect(confessable(c, new Set(), acts)).toBe(false);
  });
  it("looping an ally in gains more trust the closer they were; the risk a liar reads rises with what they can see; the confess chance is capped and rises with candor", () => {
    expect(loopInTrustGain(1)).toBeGreaterThan(loopInTrustGain(0.2));
    expect(catchRisk({ otherVersionNearListener: false, listenerDoubting: false, subjectCloseToListener: false })).toBe(0);
    expect(catchRisk({ otherVersionNearListener: true, listenerDoubting: true, subjectCloseToListener: true })).toBeGreaterThan(0.8);
    expect(confessChance(1, 1)).toBe(COMING_CLEAN.confessMax);
    expect(confessChance(0.5, 1)).toBeGreaterThan(confessChance(0.5, 0));
  });
  it("layered lies: each version to each listener is tracked by claim, with who it was confessed to and who was looped in", () => {
    const claims = [lie("c1", A), lie("c2", B, "talking-about")];
    const acts: CleanAct[] = [{ kind: "confess", by: L, to: A, claimId: "c1", week: 2 }, { kind: "loop-in", by: L, to: ALLY, claimId: "c2", toldTo: B, week: 2 }];
    const v = versionsAbout(claims, L, S, acts);
    expect(v.map((x) => [x.claim.listener, x.claim.kind, x.confessedTo, x.loopedIn])).toEqual([[A, "going-after", [A], []], [B, "talking-about", [], [ALLY]]]);
  });
});
