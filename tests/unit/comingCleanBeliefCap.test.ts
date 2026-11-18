import { describe, it, expect } from "vitest";
import { BELIEF_CAP_PER_HOLDER, beliefStoreSuperset, recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { dateRetraction, refuteToldBelief } from "../../src/engine/caughtLies";
import type { EntityId } from "../../src/domain/ids";

const HOLDER = "npc:holder" as EntityId;
const SPEAKER = "npc:speaker" as EntityId;
const edge = () => ({ trust: 0.5, affinity: 0.5, threat: 0.1 });
const told = (n: number, week: number) => ({ id: `${HOLDER}|heard-rumor|${SPEAKER}|claim:${n}`, holder: HOLDER, kind: "heard-rumor" as const, subject: SPEAKER, value: true, origin: "told" as const, source: SPEAKER, confidence: 0.6, week });
const clone = (s: BeliefStore): BeliefStore => JSON.parse(JSON.stringify(s)) as BeliefStore;

/** A holder at the cap: an old live told belief (the one a speaker will confess), two already-refuted beliefs of a later week, the rest live. */
function fullHolder(): BeliefStore {
  const store: BeliefStore = {};
  recordClaim(store, told(1, 2));
  for (let n = 2; n <= BELIEF_CAP_PER_HOLDER; n++) recordClaim(store, told(n, 5));
  store[HOLDER]![3]!.refuted = true;
  store[HOLDER]![4]!.refuted = true;
  expect(store[HOLDER]).toHaveLength(BELIEF_CAP_PER_HOLDER);
  return store;
}
/** One window: the speaker confesses the old belief away, then the holder hears a run of new claims (each past the cap lets one belief go). */
function window(store: BeliefStore, retract: boolean): void {
  const refuted = refuteToldBelief(store, HOLDER, "claim:1", edge);
  expect(refuted).toBe(true);
  if (retract) dateRetraction(store, HOLDER, "claim:1", 7);
  for (let n = 100; n < 102; n++) recordClaim(store, told(n, 7));
}

describe("a confession at the per-holder belief cap (0203 / ORW-646)", () => {
  it("without the dated retraction the old confessed belief is the first the cap takes, ahead of the older refutations (the failure)", () => {
    const before = fullHolder(); const store = clone(before);
    window(store, false);
    expect(beliefStoreSuperset(store, before)).toBe(false);
  });
  it("dated to the retraction, the confessed belief queues behind the beliefs already refuted: the save check holds", () => {
    const before = fullHolder(); const store = clone(before);
    window(store, true);
    expect(beliefStoreSuperset(store, before)).toBe(true);
    expect(store[HOLDER]).toHaveLength(BELIEF_CAP_PER_HOLDER);
    const confessed = store[HOLDER]!.find((b) => b.id.endsWith("|claim:1"));
    expect(confessed?.refuted).toBe(true); // still held, still refuted: the cap took the two older refutations first
  });
  it("dating a retraction keeps the belief's id, refutation and place in the store, and a belief not refuted is left alone", () => {
    const store = fullHolder();
    expect(dateRetraction(store, HOLDER, "claim:1", 7)).toBe(false); // live: nothing to date
    refuteToldBelief(store, HOLDER, "claim:1", edge);
    expect(dateRetraction(store, HOLDER, "claim:1", 7)).toBe(true);
    const b = store[HOLDER]!.at(-1)!;
    expect(b).toMatchObject({ id: `${HOLDER}|heard-rumor|${SPEAKER}|claim:1`, refuted: true, week: 7 });
    expect(store[HOLDER]).toHaveLength(BELIEF_CAP_PER_HOLDER);
  });
});
