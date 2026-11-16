import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { beliefFor, claimConfidence, claimProblem, claimsHeardBy, liesBy, tellClaim, type ClaimContext, type ClaimLog } from "../../src/engine/spokenClaims";

/** 0149 / ORW-330 - the claims core, pure rules. Roles only (a speaker, a listener, a subject, a second party). */
const [SPEAKER, LISTENER, SUBJECT, OTHER] = ["npc:a", "npc:b", "npc:c", "npc:d"];
const living = [PLAYER, SPEAKER, LISTENER, SUBJECT, OTHER];
const trust: Record<string, number> = { [`${LISTENER}>${SPEAKER}`]: 0.9, [`${OTHER}>${SPEAKER}`]: 0.1 };
const ctx: ClaimContext = { week: 2, day: 6, living, trustOf: (l, s) => trust[`${l}>${s}`] ?? 0.5 };
const fresh = (): { log: ClaimLog; beliefs: BeliefStore } => ({ log: { seq: 0, items: [] }, beliefs: {} });

describe("0149 the claims core", () => {
  it("a told claim becomes the NPC listener's belief, sourced to the speaker, at the speaker's reliability", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: SUBJECT, isTrue: true, intent: "warn" }, ctx);
    tellClaim(log, beliefs, { speaker: SPEAKER, listener: OTHER, kind: "targets-you", subject: SUBJECT, isTrue: true, intent: "warn" }, ctx);
    const held = beliefs[LISTENER]!;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "targets-me", subject: SUBJECT, object: LISTENER, value: true, origin: "told", source: SPEAKER, week: 2 });
    expect(held[0]!.confidence).toBe(claimConfidence(0.9, false));
    expect(held[0]!.confidence).toBeGreaterThan(beliefs[OTHER]![0]!.confidence);
  });

  it("a false claim plants the same belief a true one would; only the log knows it was a lie, and why", () => {
    const t = fresh(), f = fresh();
    tellClaim(t.log, t.beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "voted-to-evict-you", subject: SUBJECT, isTrue: true, intent: "inform" }, ctx);
    tellClaim(f.log, f.beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "voted-to-evict-you", subject: SUBJECT, isTrue: false, intent: "mislead" }, ctx);
    expect(f.beliefs).toEqual(t.beliefs);
    expect(liesBy(f.log, SPEAKER)).toMatchObject([{ isTrue: false, intent: "mislead", listener: LISTENER }]);
    expect(liesBy(t.log, SPEAKER)).toEqual([]);
  });

  it("the player listener gets no belief, and the heard view carries the words only", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, { speaker: SPEAKER, listener: PLAYER, kind: "final-two-with", subject: SUBJECT, object: OTHER, isTrue: false, intent: "mislead" }, ctx);
    tellClaim(log, beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: SUBJECT, isTrue: true, intent: "warn" }, ctx);
    expect(beliefs[PLAYER]).toBeUndefined();
    expect(claimsHeardBy(log, PLAYER)).toEqual([{ speaker: SPEAKER, kind: "final-two-with", subject: SUBJECT, object: OTHER, week: 2, day: 6 }]);
  });

  it("claims are appended with stable ids and never thinned", () => {
    const { log, beliefs } = fresh();
    for (let i = 0; i < 60; i++) tellClaim(log, beliefs, { speaker: SPEAKER, listener: LISTENER, kind: "talking-about", subject: SUBJECT, object: OTHER, isTrue: i % 2 === 0, intent: "inform" }, ctx);
    expect(log.items.map((c) => c.id)).toEqual(Array.from({ length: 60 }, (_, i) => `claim:${i + 1}`));
  });

  it("refuses malformed claims and records nothing", () => {
    const bad = [
      { speaker: SPEAKER, listener: SPEAKER, kind: "targets-you", subject: SUBJECT },
      { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: SPEAKER },
      { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: LISTENER },
      { speaker: SPEAKER, listener: LISTENER, kind: "going-after", subject: SUBJECT },
      { speaker: SPEAKER, listener: LISTENER, kind: "going-after", subject: SUBJECT, object: SUBJECT },
      { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: "npc:evicted" },
      { speaker: SPEAKER, listener: LISTENER, kind: "targets-you", subject: SUBJECT, object: OTHER },
    ] as const;
    for (const b of bad) {
      const { log, beliefs } = fresh();
      const input = { ...b, isTrue: true, intent: "inform" as const };
      expect(claimProblem(input, living), JSON.stringify(b)).toBeDefined();
      expect(tellClaim(log, beliefs, input, ctx)).toBeUndefined();
      expect(log).toEqual({ seq: 0, items: [] });
      expect(beliefs).toEqual({});
    }
  });

  it("each claim kind plants its own belief", () => {
    const m = (kind: Parameters<typeof beliefFor>[0]["kind"], object?: string) => beliefFor({ kind, listener: LISTENER, subject: SUBJECT, ...(object ? { object } : {}) });
    expect(m("targets-you")).toEqual({ kind: "targets-me", subject: SUBJECT, object: LISTENER });
    expect(m("voted-to-evict-you")).toEqual({ kind: "voted-against-me", subject: SUBJECT });
    expect(m("final-two-with", OTHER)).toEqual({ kind: "allied-with", subject: SUBJECT, object: OTHER });
    expect(m("going-after", OTHER)).toMatchObject({ kind: "heard-rumor", object: OTHER, nature: "going-after" });
    expect(m("talking-about", OTHER)).toMatchObject({ kind: "heard-rumor", object: OTHER, nature: "talking-about" });
    expect(m("lying-about")).toEqual({ kind: "lied-to-me", subject: SUBJECT });
    expect(m("lying-about", OTHER)).toMatchObject({ kind: "heard-rumor", object: OTHER, nature: "lying" });
  });
});
