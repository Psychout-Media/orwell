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
  "self-evict": true, "secret-veto": true, "deal-offer": true,
};

describe("answerPending (BDD PAT-1)", () => {
  it("answers every pending kind explicitly, echoing the kind it answers; self-evict is intentionally unanswered", () => {
    for (const kind of Object.keys(KINDS) as PendingView["kind"][]) {
      const req = answerPending({ ...base, kind } as PendingView);
      if (kind === "self-evict") expect(req, "the OOC walk-out confirmation is never auto-answered").toBeNull();
      else expect(req?.kind, kind).toBe(kind);
    }
  });

  it("throws a clear error naming an UNKNOWN pending kind instead of guessing an answer", () => {
    expect(() => answerPending({ ...base, kind: "some-new-card" } as unknown as PendingView)).toThrow(/unhandled pending decision kind 'some-new-card'/);
  });

  it("the veto policy is explicit: hold by default, use on the first nominee when asked", () => {
    expect(answerPending({ ...base, kind: "veto-decision" } as PendingView)).toEqual({ kind: "veto-decision", use: false });
    expect(answerPending({ ...base, kind: "veto-decision" } as PendingView, { useVeto: true })).toEqual({ kind: "veto-decision", use: true, save: "a" });
  });
});
