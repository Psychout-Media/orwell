import { describe, it, expect } from "vitest";
import { answerPending, type PendingView } from "../../features/support/answerPending";

/**
 * BDD PAT-1 — the shared step driver answers every pending kind EXPLICITLY and throws on an unknown one (it used to
 * fall back to `vote: options[0]`, which answered new pendings by accident). Roles only.
 */
const nominee = (id: string) => ({ id, name: id });
const base = { options: [nominee("a"), nominee("b")], appeals: ["own-game"], prompt: "" } as unknown as Omit<PendingView, "kind">;

// A Record over the kind union: adding a pending kind without listing it here is a COMPILE error, and the loop below
// then proves it has an explicit answer in the driver.
const KINDS: Record<PendingView["kind"], true> = {
  "nominations": true, "veto-decision": true, "comp-intent": true, "comp-round": true, "houseguests-choice": true,
  "replacement": true, "eviction-vote": true, "tie-break": true, "final-eviction": true, "goodbye-message": true,
  "finale-statement": true, "finale-answer": true, "juror-question": true, "juror-vote": true, "exit-interview": true,
  "self-evict": true, "secret-veto": true, "deal-offer": true, "ceremony-step": true, "spectator-choice": true, "finale-interview": true,
};

// The COMPLETE expected request for each kind (legal fields and values), so a generic `vote: options[0]` fallback or a malformed
// branch cannot pass. `null` = intentionally never auto-answered.
const EXPECTED: Record<PendingView["kind"], unknown> = {
  "nominations": { kind: "nominations", choice: ["a", "b"] },
  "veto-decision": { kind: "veto-decision", use: false },
  "comp-intent": { kind: "comp-intent", intent: "compete" },
  "comp-round": { kind: "comp-round", intent: "compete" },
  "houseguests-choice": { kind: "houseguests-choice", vote: "a" },
  "replacement": { kind: "replacement", replacement: "a" },
  "eviction-vote": { kind: "eviction-vote", vote: "a" },
  "tie-break": { kind: "tie-break", vote: "a" },
  "final-eviction": { kind: "final-eviction", vote: "a" },
  "goodbye-message": { kind: "goodbye-message", vote: "a" },
  "finale-statement": { kind: "finale-statement", statement: "I played my own game." },
  "finale-answer": { kind: "finale-answer", appeal: "own-game" },
  "juror-question": { kind: "juror-question", statement: "What was your biggest move?" },
  "juror-vote": { kind: "juror-vote", vote: "a" },
  "exit-interview": { kind: "exit-interview", vote: "a" },
  "spectator-choice": { kind: "spectator-choice", vote: "watch" },
  "finale-interview": { kind: "finale-interview", vote: "gracious" },
  "secret-veto": { kind: "secret-veto", use: false },
  "deal-offer": null, "ceremony-step": null,
  "self-evict": null,
};

describe("answerPending (BDD PAT-1)", () => {
  it("answers every pending kind with its exact, legal request (and names the kinds that are intentionally never auto-answered)", () => {
    for (const kind of Object.keys(KINDS) as PendingView["kind"][]) {
      expect(answerPending({ ...base, kind } as PendingView), kind).toEqual(EXPECTED[kind]);
    }
  });

  it("an exit interview uses the first legal posture the pending offers; a finale answer uses the offered appeal", () => {
    expect(answerPending({ ...base, kind: "exit-interview", stances: ["defiant", "gracious"] } as unknown as PendingView)).toEqual({ kind: "exit-interview", vote: "defiant" });
    expect(answerPending({ ...base, kind: "finale-answer", appeals: ["x-appeal"] } as unknown as PendingView)).toEqual({ kind: "finale-answer", appeal: "x-appeal" });
  });

  it("throws a clear error naming an UNKNOWN pending kind instead of guessing an answer", () => {
    expect(() => answerPending({ ...base, kind: "some-new-card" } as unknown as PendingView)).toThrow(/unhandled pending decision kind 'some-new-card'/);
  });

  it("the veto policy is explicit: hold by default, use on the first nominee when asked", () => {
    expect(answerPending({ ...base, kind: "veto-decision" } as PendingView)).toEqual({ kind: "veto-decision", use: false });
    expect(answerPending({ ...base, kind: "veto-decision" } as PendingView, { useVeto: true })).toEqual({ kind: "veto-decision", use: true, save: "a" });
  });
});
