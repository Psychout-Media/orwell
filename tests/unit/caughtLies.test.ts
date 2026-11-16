import { describe, it, expect } from "vitest";
import { contradicts, refuteToldBelief, voteCountRulesOut, type ClaimLike } from "../../src/engine/caughtLies";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";

/** 0154 slice 5a: the pure checks. Roles only. */
const keep = (subject: string, object: string): ClaimLike => ({ speaker: "s", listener: "l", kind: "voted-to-keep", subject, object });
const tally = (evictVotes: number, voters = ["v1", "v2", "v3"]) => ({ evictee: "e", evictVotes, voters });

describe("voteCountRulesOut (public count only)", () => {
  it("a unanimous count rules out a keep of the evictee by a voter", () => expect(voteCountRulesOut(tally(3), keep("v1", "e"))).toBe(true));
  it("any keep in the count settles nothing", () => expect(voteCountRulesOut(tally(2), keep("v1", "e"))).toBe(false));
  it("a keep of someone other than the evictee is never ruled out", () => expect(voteCountRulesOut(tally(3), keep("v1", "x"))).toBe(false));
  it("a non-voter's keep is not ruled out, nor is another kind of claim", () => {
    expect(voteCountRulesOut(tally(3), keep("hoh", "e"))).toBe(false);
    expect(voteCountRulesOut(tally(3), { ...keep("v1", "e"), kind: "voted-against" })).toBe(false);
  });
  it("an empty electorate rules nothing out", () => expect(voteCountRulesOut(tally(0, []), keep("v1", "e"))).toBe(false));
});

describe("contradicts", () => {
  const c = (kind: string, subject: string, object: string, over: Partial<ClaimLike> = {}): ClaimLike => ({ speaker: "s", listener: "l", kind, subject, object, ...over });
  it("final-two-with vs going-after on the same pair, either direction", () => {
    expect(contradicts(c("final-two-with", "a", "b"), c("going-after", "a", "b"))).toBe(true);
    expect(contradicts(c("going-after", "b", "a"), c("final-two-with", "a", "b"))).toBe(true);
  });
  it("a different pair, speaker or listener is no contradiction", () => {
    expect(contradicts(c("final-two-with", "a", "b"), c("going-after", "a", "x"))).toBe(false);
    expect(contradicts(c("final-two-with", "a", "b"), c("going-after", "a", "b", { speaker: "t" }))).toBe(false);
    expect(contradicts(c("final-two-with", "a", "b"), c("going-after", "a", "b", { listener: "m" }))).toBe(false);
  });
  it("voted-to-keep vs voted-against by the same voter on the same houseguest", () => {
    expect(contradicts(c("voted-to-keep", "v", "x"), c("voted-against", "v", "x"))).toBe(true);
    expect(contradicts(c("voted-to-keep", "v", "x"), c("voted-against", "w", "x"))).toBe(false);
  });
  it("two claims of the same kind never contradict", () => expect(contradicts(c("going-after", "a", "b"), c("going-after", "a", "b"))).toBe(false));
});

describe("refuteToldBelief", () => {
  const edge = () => ({ trust: 0.5, affinity: 0.5, threat: 0.5 });
  it("marks a belief that recorded no edge impact (refuteClaim alone would not), keeps its id, and is idempotent", () => {
    const store: BeliefStore = {};
    recordClaim(store, { id: "h|assured-me|x|claim:1", holder: "h", kind: "assured-me", subject: "x", value: true, origin: "told", confidence: 0.7, week: 1 });
    recordClaim(store, { id: "h|assured-me|x|claim:12", holder: "h", kind: "assured-me", subject: "x", value: true, origin: "told", confidence: 0.7, week: 1 });
    expect(refuteToldBelief(store, "h", "claim:1", edge)).toBe(true);
    expect(store.h![0]!.refuted).toBe(true);
    expect(store.h![0]!.id).toBe("h|assured-me|x|claim:1");
    expect(store.h![1]!.refuted).toBeUndefined();
    expect(refuteToldBelief(store, "h", "claim:1", edge)).toBe(false);
  });
});
