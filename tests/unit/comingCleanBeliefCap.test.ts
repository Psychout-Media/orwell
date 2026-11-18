import { describe, it, expect } from "vitest";
import { BELIEF_CAP_PER_HOLDER, beliefStoreSuperset, recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { refuteToldBelief } from "../../src/engine/caughtLies";
import type { EntityId } from "../../src/domain/ids";

const HOLDER = "npc:holder" as EntityId;
const SPEAKER = "npc:speaker" as EntityId;
const edge = () => ({ trust: 0.5, affinity: 0.5, threat: 0.1 });
const told = (n: number, week: number) => ({ id: `${HOLDER}|heard-rumor|${SPEAKER}|claim:${n}`, holder: HOLDER, kind: "heard-rumor" as const, subject: SPEAKER, value: true, confidence: 0.7, week, origin: "told" as const, source: SPEAKER, claimId: `claim:${n}` });
const clone = (s: BeliefStore): BeliefStore => JSON.parse(JSON.stringify(s)) as BeliefStore;

describe("a confession at the per-holder belief cap (0203 / ORW-646)", () => {
  it("the save check holds when a confession refutes an old belief and the cap then compacts (the ORW-682 rule)", () => {
    const store: BeliefStore = {};
    recordClaim(store, told(1, 2));
    for (let n = 2; n <= BELIEF_CAP_PER_HOLDER; n++) recordClaim(store, told(n, 5));
    store[HOLDER]![3]!.refuted = true;
    store[HOLDER]![4]!.refuted = true;
    expect(store[HOLDER]).toHaveLength(BELIEF_CAP_PER_HOLDER);
    const before = clone(store);
    expect(refuteToldBelief(store, HOLDER, "claim:1", edge)).toBe(true);
    for (let n = 100; n < 102; n++) recordClaim(store, told(n, 7));
    expect(beliefStoreSuperset(store, before)).toBe(true);
  });
});
