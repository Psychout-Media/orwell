import { PLAYER } from "../../src/domain/ids";
import { describe, expect, it } from "vitest";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { claimFromBelief, planSpeech, speechActionOf, truthOf, type TruthFacts } from "../../src/engine/houseSpeech";
import { beliefFor, claimProblem } from "../../src/engine/spokenClaims";

/** 0153 / ORW-330 slice 3 - house-life speech as claims the engine decides. Roles only (an actor, a listener, a target, a bystander). */
const ACTOR = "npc:a", EAR = "npc:e", TARGET = "npc:t", OTHER = "npc:o";
const living = [ACTOR, EAR, TARGET, OTHER, "player"];
const none: TruthFacts = { goalAgainst: () => false, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false };
const ctx = (over: Partial<{ beliefs: BeliefStore; facts: TruthFacts; roll: number }> = {}) => ({ living, beliefs: {}, facts: none, roll: 0, ...over });

describe("0153: what house-life speech says", () => {
  it("truth comes from the engine's records, kind by kind", () => {
    const f: TruthFacts = { goalAgainst: (w, t) => w === TARGET && t === EAR, votedToEvict: (v, e) => v === TARGET && e === EAR, votedToKeep: (v, n) => v === TARGET && n === OTHER, finalTwo: (a, b) => a === TARGET && b === OTHER, liedTo: (a, b) => a === TARGET && b === EAR, talkedAbout: (a, b) => a === TARGET && b === OTHER };
    expect(truthOf({ kind: "targets-you", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "targets-you", listener: OTHER, subject: TARGET }, f)).toBe(false);
    expect(truthOf({ kind: "voted-to-evict-you", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "final-two-with", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(true);
    expect(truthOf({ kind: "going-after", listener: OTHER, subject: TARGET, object: EAR }, f)).toBe(true);
    expect(truthOf({ kind: "talking-about", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(true);
    expect(truthOf({ kind: "lying-about", listener: EAR, subject: TARGET }, f)).toBe(true);
    expect(truthOf({ kind: "voted-against", listener: OTHER, subject: TARGET, object: EAR }, f)).toBe(true);
    expect(truthOf({ kind: "voted-against", listener: EAR, subject: TARGET, object: OTHER }, f)).toBe(false);
    expect(truthOf({ kind: "voted-to-keep", listener: OTHER, subject: TARGET, object: OTHER }, f)).toBe(true);
    expect(truthOf({ kind: "voted-to-keep", listener: EAR, subject: TARGET, object: EAR }, f)).toBe(false);
    expect(beliefFor({ kind: "voted-to-keep", listener: EAR, subject: TARGET, object: EAR })).toEqual({ kind: "assured-me", subject: TARGET });
    expect(beliefFor({ kind: "voted-to-keep", listener: OTHER, subject: TARGET, object: EAR })).toEqual({ kind: "heard-rumor", subject: TARGET, object: EAR, nature: "voted-to-keep" });
    // a speaker may claim their OWN vote, and nothing else about themselves
    expect(claimProblem({ speaker: TARGET, listener: EAR, kind: "voted-to-keep", subject: TARGET, object: EAR, isTrue: false, intent: "deflect" }, living)).toBeUndefined();
    expect(claimProblem({ speaker: TARGET, listener: EAR, kind: "voted-against", subject: TARGET, object: OTHER, isTrue: true, intent: "inform" }, living)).toBeUndefined();
    expect(claimProblem({ speaker: TARGET, listener: EAR, kind: "going-after", subject: TARGET, object: OTHER, isTrue: true, intent: "inform" }, living)).toBeDefined();
  });

  it("an untruthful plant is a story the planter does not hold; a truthful one passes on what they believe, or nothing (ORW-588: never the hidden truth)", () => {
    const lie = planSpeech("plant", ACTOR, EAR, TARGET, false, ctx())!;
    expect(lie).toMatchObject({ speaker: ACTOR, listener: EAR, subject: TARGET, isTrue: false, intent: "mislead" });
    expect(truthOf(lie, none)).toBe(false);
    expect(planSpeech("plant", ACTOR, EAR, TARGET, true, ctx())).toBeUndefined();
    // ORW-588: the target's HIDDEN goal against the listener is true, but the planter never learned it: a truthful planter has nothing to say
    expect(planSpeech("plant", ACTOR, EAR, TARGET, true, ctx({ facts: { ...none, goalAgainst: (w, t) => w === TARGET && t === EAR } }))).toBeUndefined();
    // a truthful planter who BELIEVES something damaging about the target passes it on as a warning
    const b: BeliefStore = {};
    recordClaim(b, { holder: ACTOR, kind: "targets-me", subject: TARGET, object: ACTOR, value: true, origin: "told", confidence: 0.7, week: 1 });
    expect(planSpeech("plant", ACTOR, EAR, TARGET, true, ctx({ beliefs: b }))).toMatchObject({ speaker: ACTOR, listener: EAR, kind: "going-after", subject: TARGET, object: ACTOR, intent: "warn" });
    // the engine never steers the choice of a lie by its truth: with every kind true, the lie is still told - and recorded as true by accident
    const all: TruthFacts = { goalAgainst: () => true, votedToEvict: () => true, votedToKeep: () => true, finalTwo: () => true, liedTo: () => true, talkedAbout: () => true };
    expect(planSpeech("plant", ACTOR, EAR, TARGET, false, ctx({ facts: all }))).toMatchObject({ intent: "mislead", isTrue: true });
    // a lie is never something the planter believes: holding "the target is after me", the planter does not tell the listener "the target is going after you"... as that same story
    const lie2 = planSpeech("plant", ACTOR, EAR, TARGET, false, ctx({ beliefs: b }))!;
    expect(lie2.intent).toBe("mislead");
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

import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

describe("0153: the adapter's truth reads the secret ballots (engine-only)", () => {
  it("voted-to-evict and voted-to-keep come from the recorded ballot", () => {
    const s = new GameSessionRegistry().sandboxFor(`hs-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 2 });
    const [v1, v2, nomA, nomB, stranger] = s.livingIds().filter((id) => id !== "player");
    (s as unknown as { live: { voteRecord?: unknown[] } }).live.voteRecord = [{ week: 1, evictee: nomA, voteOf: { [v1!]: nomA, [v2!]: nomB } }];
    const f = (s as unknown as { truthFacts(): TruthFacts }).truthFacts();
    expect(f.votedToEvict(v1!, nomA!)).toBe(true);
    expect(f.votedToEvict(v2!, nomA!)).toBe(false);
    expect(f.votedToKeep(v2!, nomA!)).toBe(true);   // the evictee faced the vote and v2 voted the other way
    expect(f.votedToKeep(v1!, nomA!)).toBe(false);
    expect(f.votedToKeep(v1!, nomB!)).toBe(true);   // nomB faced the vote (v2 voted for them); v1 voted against nomA
    expect(f.votedToKeep(v1!, stranger!)).toBe(false); // never faced the vote
  });
});

describe("ORW-1105: the engine never speaks for the player", () => {
  const inHouse = [ACTOR, PLAYER, TARGET, EAR];
  const held = (...holders: string[]) => { const b: BeliefStore = {}; for (const holder of holders) recordClaim(b, { holder, kind: "targets-me", subject: TARGET, object: holder, value: true, origin: "told", confidence: 0.7, week: 1 }); return b; };

  it("a houseguest fishing the player gets no claim from the engine, whatever the player holds or reads", () => {
    for (const roll of [0, 0.13, 0.5, 0.87]) {
      expect(planSpeech("fish", ACTOR, PLAYER, undefined, true, { ...ctx({ beliefs: held(PLAYER), roll }), living: inHouse, roleOf: () => "the strategist" })).toBeUndefined();
    }
  });
  it("no speech action aimed at the player yields a claim anyone but the houseguest speaks", () => {
    for (const action of ["plant", "leak", "confirm", "fish"] as const) {
      for (const truthful of [true, false]) {
        const c = planSpeech(action, ACTOR, PLAYER, TARGET, truthful, { ...ctx({ beliefs: held(PLAYER, ACTOR) }), living: inHouse, roleOf: () => "the strategist" });
        if (c) expect(c.speaker).toBe(ACTOR);
      }
    }
  });
});
