import { describe, expect, it } from "vitest";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { claimFromBelief, planSpeech, speechActionOf, truthOf, type TruthFacts } from "../../src/engine/houseSpeech";
import { beliefFor } from "../../src/engine/spokenClaims";

/** 0153 / ORW-330 slice 3 - house-life speech as claims the engine decides. Roles only (an actor, a listener, a target, a bystander). */
const ACTOR = "npc:a", EAR = "npc:e", TARGET = "npc:t", OTHER = "npc:o";
const living = [ACTOR, EAR, TARGET, OTHER, "player"];
const none: TruthFacts = { goalAgainst: () => false, votedToEvict: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false };
const ctx = (over: Partial<{ beliefs: BeliefStore; facts: TruthFacts; roll: number }> = {}) => ({ living, beliefs: {}, facts: none, roll: 0, ...over });

describe("0153: what house-life speech says", () => {
  it("truth comes from the engine's records, kind by kind", () => {
    const f: TruthFacts = { goalAgainst: (w, t) => w === TARGET && t === EAR, votedToEvict: (v, e) => v === TARGET && e === EAR, finalTwo: (a, b) => a === TARGET && b === OTHER, liedTo: (a, b) => a === TARGET && b === EAR, talkedAbout: (a, b) => a === TARGET && b === OTHER };
    expect(truthOf({ kind: "targets-you", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "targets-you", listener: OTHER, subject: TARGET }, f)).toBe(false);
    expect(truthOf({ kind: "voted-to-evict-you", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "final-two-with", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(true);
    expect(truthOf({ kind: "going-after", listener: OTHER, subject: TARGET, object: EAR }, f)).toBe(true);
    expect(truthOf({ kind: "talking-about", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(true);
    expect(truthOf({ kind: "lying-about", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "voted-against", listener: OTHER, subject: TARGET, object: EAR }, f)).toBe(true);
    expect(truthOf({ kind: "voted-against", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(false);
  });

  it("an untruthful plant is a lie the engine knows is false; a truthful one tells something true, or nothing", () => {
    const lie = planSpeech("plant", ACTOR, EAR, TARGET, false, ctx())!;
    expect(lie).toMatchObject({ speaker: ACTOR, listener: EAR, subject: TARGET, isTrue: false, intent: "mislead" });
    expect(truthOf(lie, none)).toBe(false);
    expect(planSpeech("plant", ACTOR, EAR, TARGET, true, ctx())).toBeUndefined();
    const real = planSpeech("plant", ACTOR, EAR, TARGET, true, ctx({ facts: { ...none, goalAgainst: (w, t) => w === TARGET && t === EAR } }))!;
    expect(real).toMatchObject({ kind: "targets-you", isTrue: true, intent: "warn" });
    // an untruthful plant never tells something true by accident: with every kind true there is no lie to tell
    const all: TruthFacts = { goalAgainst: () => true, votedToEvict: () => true, finalTwo: () => true, liedTo: () => true, talkedAbout: () => true };
    expect(planSpeech("plant", ACTOR, EAR, TARGET, false, ctx({ facts: all }))).toBeUndefined();
  });

  it("a leak passes on only what the speaker believes; a fish is answered by the listener's belief", () => {
    expect(planSpeech("leak", ACTOR, EAR, TARGET, true, ctx())).toBeUndefined();
    const b: BeliefStore = {};
    recordClaim(b, { holder: ACTOR, kind: "targets-me", subject: TARGET, object: ACTOR, value: true, origin: "told", confidence: 0.7, week: 1 });
    expect(planSpeech("leak", ACTOR, EAR, TARGET, true, ctx({ beliefs: b }))).toMatchObject({ speaker: ACTOR, listener: EAR, kind: "going-after", subject: TARGET, object: ACTOR, isTrue: false, intent: "inform" });
    expect(planSpeech("fish", EAR, ACTOR, TARGET, true, ctx({ beliefs: b }))).toMatchObject({ speaker: ACTOR, listener: EAR, kind: "going-after", subject: TARGET });
  });

  it("a confirm re-tells what the listener already believes; nothing to confirm, nothing said", () => {
    expect(planSpeech("confirm", ACTOR, EAR, TARGET, true, ctx())).toBeUndefined();
    const b: BeliefStore = {};
    recordClaim(b, { holder: EAR, kind: "lied-to-me", subject: TARGET, value: true, origin: "told", confidence: 0.6, week: 1 });
    expect(planSpeech("confirm", ACTOR, EAR, TARGET, true, ctx({ beliefs: b }))).toMatchObject({ speaker: ACTOR, listener: EAR, kind: "lying-about", subject: TARGET, object: EAR, intent: "recruit" });
  });

  it("a held 'they voted against me' can be said: it is passed on as voted-against, and planted in the listener as a rumor about the speaker", () => {
    const b: BeliefStore = {};
    recordClaim(b, { holder: ACTOR, kind: "voted-against-me", subject: TARGET, value: true, origin: "deduced", confidence: 0.6, week: 1 });
    const leak = planSpeech("leak", ACTOR, EAR, TARGET, true, ctx({ beliefs: b }))!;
    expect(leak).toMatchObject({ kind: "voted-against", subject: TARGET, object: ACTOR, isTrue: false });
    expect(beliefFor(leak)).toEqual({ kind: "heard-rumor", subject: TARGET, object: ACTOR, nature: "voted-against" });
    expect(beliefFor({ ...leak, listener: ACTOR })).toEqual({ kind: "voted-against-me", subject: TARGET });
  });

  it("beliefs without a claim form, refuted ones, and ones about the listener are never passed on", () => {
    const base = { holder: ACTOR, value: true, origin: "told" as const, confidence: 0.6, week: 1, id: "x" };
    expect(claimFromBelief({ ...base, kind: "holds-power", subject: TARGET }, ACTOR, EAR)).toBeUndefined();
    expect(claimFromBelief({ ...base, kind: "targets-me", subject: TARGET, refuted: true }, ACTOR, EAR)).toBeUndefined();
    expect(claimFromBelief({ ...base, kind: "targets-me", subject: EAR }, ACTOR, EAR)).toBeUndefined();
  });

  it("a campaign's flip-a-vote and a frame are plants; other actions say nothing", () => {
    expect(speechActionOf("flip-a-vote")).toBe("plant");
    expect(speechActionOf("frame")).toBe("plant");
    expect(speechActionOf("cook")).toBeUndefined();
  });
});
