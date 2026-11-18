import { describe, expect, it } from "vitest";
import { recordClaim, targetsMeTilt, type BeliefStore } from "../../src/engine/beliefStore";
import { BELIEF_PULL, beliefPull, believedGrievance, believedGrievances } from "../../src/engine/beliefDecisions";
import { REASONS } from "../../src/engine/agendaConstants";

/** 0150 / ORW-330 slice 2 - beliefs drive decisions, pure rules. Roles only (a holder, a subject, a bystander). */
const HOLDER = "npc:h", SUBJECT = "npc:s", OTHER = "npc:o";
const store = (): BeliefStore => ({});
const claim = (s: BeliefStore, c: Partial<Parameters<typeof recordClaim>[1]>) =>
  recordClaim(s, { holder: HOLDER, kind: "targets-me", subject: SUBJECT, value: true, origin: "told", confidence: 0.6, week: 1, ...c } as Parameters<typeof recordClaim>[1]);

describe("0150 beliefs drive decisions", () => {
  it("every grievance kind counts, at its own weight; other beliefs do not", () => {
    for (const [kind, extra, w] of [
      ["targets-me", { object: HOLDER }, 1], ["voted-against-me", {}, 1], ["lied-to-me", {}, 0.8], ["heard-rumor", { nature: "going-after", object: HOLDER }, 0.8],
    ] as const) {
      const s = store(); claim(s, { kind, ...extra });
      expect(believedGrievance(s, HOLDER, SUBJECT, 1).strength, kind).toBeCloseTo(0.6 * w);
    }
    for (const [kind, extra] of [["allied-with", { object: OTHER }], ["heard-rumor", { nature: "going-after", object: OTHER }], ["targets-me", { object: OTHER }], ["holds-power", {}]] as const) {
      const s = store(); claim(s, { kind, ...extra });
      expect(believedGrievance(s, HOLDER, SUBJECT, 1).strength, `${kind} ${JSON.stringify(extra)}`).toBe(0);
    }
  });

  it("a refuted or disbelieved belief does not count; an old one fades", () => {
    const refuted = store(); claim(refuted, { kind: "voted-against-me", refuted: true });
    const disbelieved = store(); claim(disbelieved, { kind: "voted-against-me", value: false });
    expect(believedGrievance(refuted, HOLDER, SUBJECT, 1).strength).toBe(0);
    expect(believedGrievance(disbelieved, HOLDER, SUBJECT, 1).strength).toBe(0);
    const s = store(); claim(s, { kind: "voted-against-me" });
    expect(believedGrievance(s, HOLDER, SUBJECT, 1 + BELIEF_PULL.halfLifeWeeks).strength).toBeCloseTo(0.3);
  });

  it("full strength is on a goal's scale; capped is exactly the old targets-me tilt", () => {
    const s = store(); claim(s, { kind: "targets-me", object: HOLDER }); claim(s, { kind: "voted-against-me" });
    const g = believedGrievance(s, HOLDER, SUBJECT, 1).strength;
    expect(g).toBeCloseTo(1 - 0.4 * 0.4);
    expect(beliefPull(s, HOLDER, SUBJECT, 1, { strength: "full" })).toBeCloseTo(REASONS.goalWeight * g);
    expect(beliefPull(s, HOLDER, SUBJECT, 1, { strength: "capped" })).toBe(targetsMeTilt(s, HOLDER, SUBJECT, 1));
    expect(beliefPull(s, HOLDER, SUBJECT, 1, { strength: "full" })).toBeGreaterThan(3 * beliefPull(s, HOLDER, SUBJECT, 1, { strength: "capped" }));
  });

  it("only a grievance over the bar can form a goal, and only at full strength", () => {
    const s = store(); claim(s, { kind: "voted-against-me", confidence: 0.8 }); claim(s, { kind: "lied-to-me", subject: OTHER, confidence: 0.6 });
    const formed = believedGrievances(s, HOLDER, [SUBJECT, OTHER], 1, { strength: "full" }); // ORW-637: 0.8 is held as a fact, at a graded 0.85 (full only at 0.9); the doubted lie (0.6 x 0.8 = 0.48) is under the bar
    expect(formed.map((g) => [g.toward, g.ref])).toEqual([[SUBJECT, "voted-against-me"]]);
    expect(formed[0]!.strength).toBeCloseTo(0.85);
    expect(believedGrievances(s, HOLDER, [SUBJECT, OTHER], 1, { strength: "capped" })).toEqual([]);
  });
});

import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BELIEF_RULES } from "../../src/engine/beliefDecisions";

describe("0150: the live nomination and vote read is the full-strength belief pull", () => {
  it("a believed vote against the HOH pushes the live read on a goal's scale; capped, the old small tilt", () => {
    const s = new GameSessionRegistry().sandboxFor(`bd-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 4 });
    const [hoh, subject] = s.livingIds().filter((id) => id !== "player");
    const live = (s as unknown as { live: { beliefs?: BeliefStore; week: number } }).live;
    recordClaim((live.beliefs ??= {}), { holder: hoh!, kind: "voted-against-me", subject: subject!, value: true, origin: "deduced", confidence: 0.6, week: live.week });
    const tilt = () => (s as unknown as { beliefNomTiltFor(subject: string, holder: string): number }).beliefNomTiltFor(subject!, hoh!); // TEST-ONLY: the live read
    expect(tilt()).toBeCloseTo(REASONS.goalWeight * 0.6);
    try { BELIEF_RULES.strength = "capped"; expect(tilt()).toBe(0); } finally { BELIEF_RULES.strength = "full"; }
  });
});

import { convictionWeight } from "../../src/engine/beliefDecisions";
import { CONVICTION } from "../../src/engine/beliefConviction";
import { ASSURANCE } from "../../src/engine/assurances";

describe("ORW-637 (Fable S-6): a belief's weight is graded, with no cliff at asFact", () => {
  it("in proportion below asFact, continuous through it, full only at certain", () => {
    expect(convictionWeight(0.5)).toBeCloseTo(0.5);
    expect(convictionWeight(CONVICTION.asFact - 1e-9)).toBeCloseTo(convictionWeight(CONVICTION.asFact), 6); // no jump
    expect(convictionWeight(CONVICTION.asFact)).toBeCloseTo(CONVICTION.asFact);
    expect(convictionWeight(CONVICTION.certain)).toBe(1);
    expect(convictionWeight(1)).toBe(1);
    for (let c = 0; c < 1; c += 0.05) expect(convictionWeight(c + 0.05)).toBeGreaterThanOrEqual(convictionWeight(c));
  });

  it("one broken casual assurance no longer founds a revenge by itself; two separate ones do; one trusted tell of a threat still does", () => {
    const one = store(); claim(one, { kind: "lied-to-me", origin: "witnessed", confidence: ASSURANCE.brokenClaimConfidence });
    expect(believedGrievances(one, HOLDER, [SUBJECT], 1, { strength: "full" })).toEqual([]);
    const two = store();
    claim(two, { kind: "lied-to-me", origin: "witnessed", confidence: ASSURANCE.brokenClaimConfidence, week: 1 });
    claim(two, { kind: "lied-to-me", origin: "witnessed", confidence: ASSURANCE.brokenClaimConfidence, week: 2 }); // a second broken promise, a week later
    const both = believedGrievance(two, HOLDER, SUBJECT, 2).strength;
    expect(both).toBeGreaterThanOrEqual(BELIEF_PULL.revengeBar);
    const tell = store(); claim(tell, { kind: "targets-me", origin: "told", source: OTHER, confidence: 0.77 });
    expect(believedGrievances(tell, HOLDER, [SUBJECT], 1, { strength: "full" }).map((g) => g.toward)).toEqual([SUBJECT]);
  });
});
