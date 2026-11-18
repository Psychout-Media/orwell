import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { BELIEF_CAP_PER_HOLDER, beliefStoreSuperset, recordClaim, refuteClaim, type BeliefClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { BELIEF_PULL, believedGrievance, believedGrievances, beliefPull } from "../../src/engine/beliefDecisions";
import { CONVICTION, pathwayEvidence } from "../../src/engine/beliefConviction";
import { refuteToldBelief } from "../../src/engine/caughtLies";
import { claimConfidence, claimLogSuperset, tellClaim, type ClaimContext, type ClaimInput, type ClaimLog } from "../../src/engine/spokenClaims";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-591 (Fable audit T2-8) - a repeated claim is not fresh proof, the belief cap lets go of what is refuted first, and the save check guards
 * claims and beliefs. Roles only: a speaker, a second speaker, a listener (the holder), a subject, the player.
 */
const [SPEAKER, SECOND, LISTENER, SUBJECT] = ["npc:a", "npc:b", "npc:c", "npc:d"];
const living = [PLAYER, SPEAKER, SECOND, LISTENER, SUBJECT];
const WEEK = 3;
/** Trust 0.5 in every speaker: one telling lands at 0.5 (below the revenge bar), three stacked would clear it. */
const ctx: ClaimContext = { week: WEEK, living, trustOf: () => 0.5 };
const fresh = (): { log: ClaimLog; beliefs: BeliefStore } => ({ log: { seq: 0, items: [] }, beliefs: {} });
const targets = (speaker: string, subject: string): ClaimInput => ({ speaker, listener: LISTENER, kind: "targets-you", subject, isTrue: false, intent: "mislead" });
const one = claimConfidence(0.5, false);

describe("ORW-591 a repeat of the same claim is not fresh proof", () => {
  it("the bar is real: one telling is below the revenge bar, three independent ones would clear it", () => {
    expect(one).toBeLessThan(CONVICTION.asFact);                       // weighed at its confidence, not as a fact
    expect(one * BELIEF_PULL.kindWeight["targets-me"]).toBeLessThan(BELIEF_PULL.revengeBar);
    expect(1 - Math.pow(1 - one, 3)).toBeGreaterThanOrEqual(BELIEF_PULL.revengeBar);
  });

  for (const subject of [SUBJECT, PLAYER]) {
    const about = subject === PLAYER ? "about the player" : "about another houseguest";
    it(`three tellings from ONE speaker plant one belief and do not clear a bar one telling does not (${about})`, () => {
      const once = fresh(), thrice = fresh();
      tellClaim(once.log, once.beliefs, targets(SPEAKER, subject), ctx);
      for (let i = 0; i < 3; i++) tellClaim(thrice.log, thrice.beliefs, targets(SPEAKER, subject), ctx);
      expect(thrice.log.items).toHaveLength(3);                          // every telling is kept in the log
      expect(thrice.beliefs[LISTENER]).toHaveLength(1);                  // ... but it is one belief
      expect(thrice.beliefs[LISTENER]![0]!.alsoClaims).toEqual(["claim:2", "claim:3"]);
      const g1 = believedGrievance(once.beliefs, LISTENER, subject, WEEK).strength;
      const g3 = believedGrievance(thrice.beliefs, LISTENER, subject, WEEK).strength;
      expect(g3).toBeCloseTo(g1, 12);
      expect(beliefPull(thrice.beliefs, LISTENER, subject, WEEK)).toBeCloseTo(beliefPull(once.beliefs, LISTENER, subject, WEEK), 12);
      expect(believedGrievances(thrice.beliefs, LISTENER, [subject], WEEK)).toEqual([]);
    });
  }

  it("a repeat refreshes the belief: the newer week and the higher confidence are kept, never lowered", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), { ...ctx, trustOf: () => 0.9 });
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), { ...ctx, week: WEEK + 2, trustOf: () => 0.1 });
    const b = beliefs[LISTENER]!;
    expect(b).toHaveLength(1);
    expect(b[0]!.week).toBe(WEEK + 2);
    expect(b[0]!.confidence).toBe(claimConfidence(0.9, false));
  });

  it("the reader counts one source's repeats once even when a writer kept them as separate beliefs", () => {
    // e.g. the heard-about-me writer keeps one belief per teller per week: the same teller saying it again next week is still one source
    const told = (week: number): BeliefClaim => ({ id: `${LISTENER}|targets-me|${SUBJECT}|told:${SPEAKER}|${week}`, holder: LISTENER, kind: "targets-me", subject: SUBJECT, object: LISTENER, value: true, origin: "told", source: SPEAKER, confidence: one, week });
    const single: BeliefStore = { [LISTENER]: [told(WEEK)] };
    const repeated: BeliefStore = { [LISTENER]: [told(WEEK), { ...told(WEEK), id: `${told(WEEK).id}#2` }, { ...told(WEEK), id: `${told(WEEK).id}#3` }] };
    expect(believedGrievance(repeated, LISTENER, SUBJECT, WEEK).strength).toBeCloseTo(believedGrievance(single, LISTENER, SUBJECT, WEEK).strength, 12);
    expect(believedGrievances(repeated, LISTENER, [SUBJECT], WEEK)).toEqual([]);
  });

  it("the player telling an NPC the same thing three times is one belief too (the player as speaker)", () => {
    const { log, beliefs } = fresh();
    for (let i = 0; i < 3; i++) tellClaim(log, beliefs, targets(PLAYER, SUBJECT), ctx);
    expect(beliefs[LISTENER]).toHaveLength(1);
    expect(beliefs[LISTENER]![0]!.source).toBe(PLAYER);
    expect(believedGrievances(beliefs, LISTENER, [SUBJECT], WEEK)).toEqual([]);
  });

  it("a lie caught on a REPEAT still finds and takes back the belief that telling joined", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    const repeat = tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx)!;
    const edge = { trust: 0.5, affinity: 0.5, threat: 0.5 };
    expect(refuteToldBelief(beliefs, LISTENER, repeat.id, () => edge)).toBe(true);
    expect(beliefs[LISTENER]![0]!.refuted).toBe(true);
  });

  it("after the belief is let go, the same speaker saying it again plants a fresh belief (the refuted one is not revived)", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    beliefs[LISTENER]![0]!.refuted = true;
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    expect(beliefs[LISTENER]!.map((b) => b.refuted === true)).toEqual([true, false]);
  });
});

describe("ORW-591 a second DISTINCT source is real corroboration", () => {
  it("two different speakers plant two beliefs that stack past one telling, and clear the bar three would", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    tellClaim(log, beliefs, targets(SECOND, SUBJECT), ctx);
    expect(beliefs[LISTENER]).toHaveLength(2);
    expect(believedGrievance(beliefs, LISTENER, SUBJECT, WEEK).strength).toBeCloseTo(1 - (1 - one) ** 2, 12);
    tellClaim(log, beliefs, { ...targets(SECOND, SUBJECT), speaker: PLAYER }, ctx);  // a third, different source (the player)
    expect(believedGrievances(beliefs, LISTENER, [SUBJECT], WEEK).map((g) => g.toward)).toEqual([SUBJECT]);
  });

  it("testing a doubt: a second source supports it; the same source repeating does not", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    const doubt = beliefs[LISTENER]![0]!;
    expect(pathwayEvidence(doubt, beliefs[LISTENER]!, LISTENER)).toBe(-CONVICTION.fade); // a repeat is no new evidence: the doubt fades
    tellClaim(log, beliefs, targets(SECOND, SUBJECT), ctx);
    expect(pathwayEvidence(doubt, beliefs[LISTENER]!, LISTENER)).toBe(CONVICTION.step);
  });

  it("one source denying it twice is one piece of evidence against, not two", () => {
    const base: BeliefClaim = { id: `${LISTENER}|targets-me|${SUBJECT}|claim:1`, holder: LISTENER, kind: "targets-me", subject: SUBJECT, object: LISTENER, value: true, origin: "told", source: SPEAKER, confidence: one, week: WEEK };
    const support: BeliefClaim = { ...base, id: `${LISTENER}|targets-me|${SUBJECT}|claim:2`, source: SECOND };
    const denial = (n: number): BeliefClaim => ({ ...base, id: `${LISTENER}|targets-me|${SUBJECT}|deny:${n}`, value: false, source: PLAYER });
    // one supporter vs one denier repeating themselves: even, so the doubt just fades (counting the repeat would tip it against)
    expect(pathwayEvidence(base, [base, support, denial(1), denial(2)], LISTENER)).toBe(-CONVICTION.fade);
  });
});

const claimsOfWeeks = (st: BeliefStore): number[] => (st[LISTENER] ?? []).map((b) => b.week);

describe("ORW-591 the save check guards the claim log and the beliefs", () => {
  const snap = (live: Record<string, unknown>): SessionSnapshot => ({ live } as unknown as SessionSnapshot);
  const belief = (n: number, extra: Partial<BeliefClaim> = {}): BeliefClaim => ({ id: `${LISTENER}|targets-me|npc:s${n}|x`, holder: LISTENER, kind: "targets-me", subject: `npc:s${n}`, object: LISTENER, value: true, origin: "told", source: SPEAKER, confidence: 0.5, week: n, ...extra });
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it("a dropped claim, or a claim counter that goes back, is a violation", () => {
    const { log, beliefs } = fresh();
    for (let i = 0; i < 3; i++) tellClaim(log, beliefs, targets(i === 1 ? SECOND : SPEAKER, SUBJECT), ctx);
    const earlier = snap({ claims: clone(log), beliefs: clone(beliefs) });
    expect(sessionCoreSupersetViolation(earlier, earlier)).toBeNull();
    const dropped = clone(log); dropped.items.splice(1, 1);
    expect(sessionCoreSupersetViolation(snap({ claims: dropped, beliefs: clone(beliefs) }), earlier)).toBe("claims");
    const back = clone(log); back.seq -= 1;
    expect(sessionCoreSupersetViolation(snap({ claims: back, beliefs: clone(beliefs) }), earlier)).toBe("claims");
    expect(claimLogSuperset(undefined, log)).toBe(false);
    expect(claimLogSuperset(log, undefined)).toBe(true);
  });

  it("a dropped live belief, a dropped refuted one below the cap, or a forgotten folded telling is a violation", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    tellClaim(log, beliefs, targets(SPEAKER, SUBJECT), ctx);
    tellClaim(log, beliefs, targets(SECOND, SUBJECT), ctx);
    beliefs[LISTENER]![1]!.refuted = true;
    const earlier = snap({ claims: clone(log), beliefs: clone(beliefs) });
    const live = clone(beliefs); live[LISTENER]!.splice(0, 1);
    expect(sessionCoreSupersetViolation(snap({ claims: clone(log), beliefs: live }), earlier)).toBe("beliefs");
    const refuted = clone(beliefs); refuted[LISTENER]!.splice(1, 1);
    expect(sessionCoreSupersetViolation(snap({ claims: clone(log), beliefs: refuted }), earlier)).toBe("beliefs");
    const forgot = clone(beliefs); delete forgot[LISTENER]![0]!.alsoClaims;
    expect(sessionCoreSupersetViolation(snap({ claims: clone(log), beliefs: forgot }), earlier)).toBe("beliefs");
    const gone = clone(beliefs); delete gone[LISTENER];
    expect(sessionCoreSupersetViolation(snap({ claims: clone(log), beliefs: gone }), earlier)).toBe("beliefs");
  });

  it("at the cap, losing a refuted belief is allowed; losing a live one while a refuted one survives is not", () => {
    const full: BeliefStore = { [LISTENER]: Array.from({ length: BELIEF_CAP_PER_HOLDER }, (_, i) => belief(i, i === 7 ? { refuted: true } : {})) };
    const earlier = snap({ beliefs: full });
    const tookRefuted = clone(full); tookRefuted[LISTENER]!.splice(7, 1); tookRefuted[LISTENER]!.push(belief(100));
    expect(sessionCoreSupersetViolation(snap({ beliefs: tookRefuted }), earlier)).toBeNull();
    const tookLive = clone(full); tookLive[LISTENER]!.splice(20, 1); tookLive[LISTENER]!.push(belief(100));
    expect(sessionCoreSupersetViolation(snap({ beliefs: tookLive }), earlier)).toBe("beliefs");
    const noneRefuted: BeliefStore = { [LISTENER]: Array.from({ length: BELIEF_CAP_PER_HOLDER }, (_, i) => belief(i)) };
    const tookOldest = clone(noneRefuted); tookOldest[LISTENER]!.splice(0, 1); tookOldest[LISTENER]!.push(belief(100));
    expect(sessionCoreSupersetViolation(snap({ beliefs: tookOldest }), snap({ beliefs: noneRefuted }))).toBeNull();
  });

  it("ORW-682: a live belief refuted and compacted within ONE commit, with an older-refuted-first rule, passes; a live loss ahead of a not-older refuted survivor is still refused", () => {
    // earlier save: at the cap; the live belief at week 2 and a refuted belief at week 10
    const full: BeliefStore = { [LISTENER]: Array.from({ length: BELIEF_CAP_PER_HOLDER }, (_, i) => belief(i, i === 10 ? { refuted: true } : {})) };
    const earlier = clone(full);
    // within one commit: the week-2 belief is refuted, then a new write compacts - the oldest REFUTED belief is now the week-2 one
    const later = clone(full);
    const cap = later[LISTENER]!;
    cap[2]!.refuted = true;
    recordClaim(later, belief(100));
    expect(claimsOfWeeks(later)).not.toContain(2);
    expect(claimsOfWeeks(later)).toContain(10);                       // the older-refuted one survives, as the cap's rule dictates
    expect(beliefStoreSuperset(later, earlier)).toBe(true);
    // the seed-8 shape: two refuted beliefs of the SAME week; the one refuted in-commit sits earlier in the list, so the tie goes to it (not the older-written refuted one)
    const tie: BeliefStore = { [LISTENER]: Array.from({ length: BELIEF_CAP_PER_HOLDER }, (_, i) => belief(i, { week: 3, ...(i === 6 ? { refuted: true } : {}) })) };
    const tieLater = clone(tie);
    tieLater[LISTENER]![2]!.refuted = true;
    recordClaim(tieLater, belief(100, { week: 8 }));
    expect(tieLater[LISTENER]!.map((b) => b.id)).not.toContain(tie[LISTENER]![2]!.id);
    expect(tieLater[LISTENER]!.map((b) => b.id)).toContain(tie[LISTENER]![6]!.id);
    expect(beliefStoreSuperset(tieLater, tie)).toBe(true);
    // real degradation still refused: a live belief NEWER than a surviving refuted one cannot be the loss
    const bad = clone(full);
    bad[LISTENER]!.splice(20, 1); bad[LISTENER]!.push(belief(100));
    expect(beliefStoreSuperset(bad, earlier)).toBe(false);
    // ... and a live loss below the cap is refused as ever
    const below = clone(full); below[LISTENER]!.splice(2, 1);
    expect(beliefStoreSuperset(below, earlier)).toBe(false);
  });

  it("the cap's own compaction always passes the save check (writes, repeats and refutations, step by step)", () => {
    const { log, beliefs } = fresh();
    const speakers = [SPEAKER, SECOND, PLAYER];
    const edge = { trust: 0.5, affinity: 0.5, threat: 0.5 };
    for (let i = 0; i < 4 * BELIEF_CAP_PER_HOLDER; i++) {
      const before = clone(beliefs);
      if (i % 5 === 4) {
        const live = (beliefs[LISTENER] ?? []).find((b) => !b.refuted);
        if (live) { refuteClaim(beliefs, LISTENER, live.id, () => edge); live.refuted = true; }
      } else if (i % 3 === 2) {
        tellClaim(log, beliefs, targets(speakers[Math.floor(i / 3) % 3]!, SUBJECT), { ...ctx, week: i });                  // a repeat (folds)
      } else {
        recordClaim(beliefs, { ...belief(1000 + i), id: `${LISTENER}|deduced|${i}`, origin: "deduced", week: i }); // a new belief
      }
      expect(beliefStoreSuperset(beliefs, before), `step ${i}`).toBe(true);
      expect((beliefs[LISTENER] ?? []).length).toBeLessThanOrEqual(BELIEF_CAP_PER_HOLDER);
    }
  });
});

describe("ORW-591: a re-record never revives a refuted belief", () => {
  it("a stronger re-record of the same claim id keeps the refuted flag and what the refutation took back", async () => {
    const { recordClaim } = await import("../../src/engine/beliefStore");
    const store: Record<string, Array<Record<string, unknown>>> = {};
    const base = { id: "h|lied-to-me|x|1", holder: "h", kind: "lied-to-me", subject: "x", value: true, origin: "told", confidence: 0.4, week: 1 };
    recordClaim(store as never, base as never);
    Object.assign(store.h![0]!, { refuted: true, reversed: { trust: 0.02 } });
    expect(recordClaim(store as never, { ...base, confidence: 0.9 } as never)).toBe(true);
    expect(store.h![0]).toMatchObject({ confidence: 0.9, refuted: true, reversed: { trust: 0.02 } });
  });
});
