import { describe, it, expect } from "vitest";
import { judgePromise, isPromiseTerm, termAssuranceKind, brokenPromiseClaimId, PROMISE_WHATS, type PromiseTerm, type PromiseBoardFact } from "../../src/engine/promiseTerms";
import { closeOpenEntry, emptyOpenLedger, openLedgerSuperset, recordOpenEntry, resolveOpenEntry, restoreOpenLedger, type OpenLedger } from "../../src/engine/openLedger";

/** ORW-586 / 0187 - the closed promise term and its deterministic judge, and how the open ledger carries a term. Roles only: the promiser, the promisee, a third houseguest. */
const P = "role:promiser", Q = "role:promisee", T = "role:third", U = "role:other";
const term = (what: PromiseTerm["what"], extra: Partial<PromiseTerm> = {}): PromiseTerm => ({ by: P, to: Q, what, week: 2, ...extra });
const fact = <F extends PromiseBoardFact>(f: F): F => f;

describe("judgePromise: one verdict per term and board fact", () => {
  it("no-nominate: broken when the promiser nominates the subject, kept when final nominations leave the subject off", () => {
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominated", week: 2, by: P, nominee: Q }))).toBe("broken");
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominated", week: 2, by: P, nominee: T }))).toBeUndefined();
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominations-final", week: 2, by: P, nominees: [T, U] }))).toBe("kept");
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominations-final", week: 2, by: P, nominees: [Q, U] }))).toBe("broken");
  });
  it("no-nominate about a third person judges on that third person, not the one it was said to", () => {
    const t = term("no-nominate", { subject: T });
    expect(judgePromise(t, fact({ kind: "nominated", week: 2, by: P, nominee: T }))).toBe("broken");
    expect(judgePromise(t, fact({ kind: "nominated", week: 2, by: P, nominee: Q }))).toBeUndefined();
  });
  it("no-evict-vote: broken when the subject is voted out, kept when the other nominee is, nothing when the subject was never on the ballot", () => {
    expect(judgePromise(term("no-evict-vote"), fact({ kind: "eviction-vote", week: 2, by: P, votedOut: Q, sealed: false }))).toBe("broken");
    expect(judgePromise(term("no-evict-vote"), fact({ kind: "eviction-vote", week: 2, by: P, spared: Q, sealed: false }))).toBe("kept");
    expect(judgePromise(term("no-evict-vote"), fact({ kind: "eviction-vote", week: 2, by: P, votedOut: T, sealed: false }))).toBeUndefined();
  });
  it("use-veto-on: kept when the veto is used on the subject, broken when it is used on another or not at all", () => {
    expect(judgePromise(term("use-veto-on"), fact({ kind: "veto-used", week: 2, by: P, on: Q }))).toBe("kept");
    expect(judgePromise(term("use-veto-on"), fact({ kind: "veto-used", week: 2, by: P, on: T }))).toBe("broken");
    expect(judgePromise(term("use-veto-on"), fact({ kind: "veto-used", week: 2, by: P }))).toBe("broken");
  });
  it("not-use-veto-on: broken when the veto is used on the subject, kept otherwise", () => {
    expect(judgePromise(term("not-use-veto-on"), fact({ kind: "veto-used", week: 2, by: P, on: Q }))).toBe("broken");
    expect(judgePromise(term("not-use-veto-on"), fact({ kind: "veto-used", week: 2, by: P }))).toBe("kept");
  });
  it("final-two: kept when both reach it, broken when the promiser is there without the subject, nothing when the promiser is gone", () => {
    expect(judgePromise(term("final-two"), fact({ kind: "final-two", week: 9, finalists: [P, Q] }))).toBe("kept");
    expect(judgePromise(term("final-two", { window: "season", week: 1 }), fact({ kind: "final-two", week: 9, finalists: [P, Q] }))).toBe("kept"); // the final-two fact is the end of the season: it settles whatever the week
    expect(judgePromise(term("final-two", { window: "season", week: 1 }), fact({ kind: "final-two", week: 9, finalists: [P, T] }))).toBe("broken");
    expect(judgePromise(term("final-two", { window: "season" }), fact({ kind: "final-two", week: 9, finalists: [T, U] }))).toBeUndefined();
  });
  it("share-info is open text and is never judged, whatever the fact", () => {
    const t = term("share-info");
    for (const f of [fact({ kind: "nominated", week: 2, by: P, nominee: Q }), fact({ kind: "nominations-final", week: 2, by: P, nominees: [] }), fact({ kind: "eviction-vote", week: 2, by: P, votedOut: Q, sealed: false }), fact({ kind: "veto-used", week: 2, by: P, on: Q })]) expect(judgePromise(t, f)).toBeUndefined();
  });
  it("a fact by someone else, or from another week (window week), says nothing", () => {
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominated", week: 2, by: T, nominee: Q }))).toBeUndefined();
    expect(judgePromise(term("no-nominate"), fact({ kind: "nominated", week: 3, by: P, nominee: Q }))).toBeUndefined();
    expect(judgePromise(term("no-nominate", { window: "season" }), fact({ kind: "nominated", week: 3, by: P, nominee: Q }))).toBe("broken");
  });
  it("is pure: the same term and fact always give the same verdict and neither is changed", () => {
    const t = term("no-nominate"); const f = fact({ kind: "nominated", week: 2, by: P, nominee: Q });
    const before = JSON.stringify([t, f]);
    expect([judgePromise(t, f), judgePromise(t, f)]).toEqual(["broken", "broken"]);
    expect(JSON.stringify([t, f])).toBe(before);
  });
  it("every term kind is covered by a judge case (a new kind must get a row here)", () => {
    expect(PROMISE_WHATS.length).toBe(6);
  });
});

describe("the term shape and its helpers", () => {
  it("accepts a well-formed term and refuses the malformed ones", () => {
    expect(isPromiseTerm(term("no-nominate"))).toBe(true);
    for (const bad of [null, [], { by: P }, { ...term("no-nominate"), what: "anything" }, { ...term("no-nominate"), to: P }, { ...term("no-nominate"), window: "forever" }, { ...term("no-nominate"), week: -1 }, { ...term("no-nominate"), extra: 1 }, { ...term("no-nominate"), subject: 5 }]) expect(isPromiseTerm(bad)).toBe(false);
  });
  it("the casual-assurance ledger folds only the two kinds about the one it was said to", () => {
    expect(termAssuranceKind(term("no-nominate"))).toBe("loyal");
    expect(termAssuranceKind(term("no-evict-vote"))).toBe("vote");
    expect(termAssuranceKind(term("no-nominate", { subject: T }))).toBeUndefined();
    expect(termAssuranceKind(term("use-veto-on"))).toBeUndefined();
  });
  it("the lied-to-me claim id is stable per wronged, promiser and entry", () => {
    expect(brokenPromiseClaimId(Q, P, "open:3")).toBe(brokenPromiseClaimId(Q, P, "open:3"));
    expect(brokenPromiseClaimId(Q, P, "open:3")).not.toBe(brokenPromiseClaimId(Q, P, "open:4"));
  });
});

describe("the open ledger carries a term", () => {
  const ctx = { turn: 1, beatSeq: 1, room: "r", witnesses: [P, Q] };
  const prop = { text: "I will not put you up", speaker: P, addressedTo: [Q], kind: "promise" };
  const withTerm = (): OpenLedger => recordOpenEntry(emptyOpenLedger(), prop, { ...ctx, term: term("no-nominate") }).ledger;
  it("a free-text entry has no term field at all (byte-identical)", () => {
    const l = recordOpenEntry(emptyOpenLedger(), prop, ctx).ledger;
    expect("term" in l.entries[0]!).toBe(false);
  });
  it("the term is kept on the entry, and survives a save and load unchanged, with its outcome", () => {
    const l = closeOpenEntry(withTerm(), "open:1", "broken", "engine judged broken at the nominated", 4);
    const back = restoreOpenLedger(JSON.parse(JSON.stringify(l)));
    expect(back.problems).toBe(0);
    expect(back.ledger).toEqual(l);
    expect(back.ledger.entries[0]!.term).toEqual(term("no-nominate"));
    expect(back.ledger.entries[0]!.status).toBe("broken");
  });
  it("a malformed saved term is dropped, the entry stays as free text, and writes are never locked", () => {
    const raw = JSON.parse(JSON.stringify(withTerm())) as { entries: Array<Record<string, unknown>> };
    raw.entries[0]!.term = { by: P, what: "nonsense" };
    const back = restoreOpenLedger(raw);
    expect(back.problems).toBe(0);
    expect(back.droppedTerms).toBe(1);
    expect(back.ledger.entries).toHaveLength(1);
    expect("term" in back.ledger.entries[0]!).toBe(false);
  });
  it("superset: a resolution keeps it; changing, adding or removing a term is refused", () => {
    const a = withTerm();
    expect(openLedgerSuperset(a, closeOpenEntry(a, "open:1", "kept", "n", 2))).toBe(true);
    const changed: OpenLedger = { ...a, entries: [{ ...a.entries[0]!, term: term("no-evict-vote") }] };
    expect(openLedgerSuperset(a, changed)).toBe(false);
    const { term: _t, ...bare } = a.entries[0]!;
    expect(openLedgerSuperset(a, { ...a, entries: [bare as never] })).toBe(false);
    expect(openLedgerSuperset({ ...a, entries: [bare as never] }, a)).toBe(false);
  });
  it("a model's kept or broken on a termed entry is refused (it may only withdraw); a free-text entry still resolves", () => {
    const a = withTerm();
    for (const status of ["kept", "broken"]) expect(resolveOpenEntry(a, { entryId: "open:1", status, note: "x" }, 2, { refuseTermed: true })).toMatchObject({ outcome: "engine-judged", ledger: a });
    expect(resolveOpenEntry(a, { entryId: "open:1", status: "withdrawn", note: "x" }, 2, { refuseTermed: true }).outcome).toBe("resolved");
    expect(resolveOpenEntry(a, { entryId: "open:1", status: "kept", note: "x" }, 2).outcome).toBe("resolved"); // the flag off: as before
    const free = recordOpenEntry(emptyOpenLedger(), prop, ctx).ledger;
    expect(resolveOpenEntry(free, { entryId: "open:1", status: "kept", note: "x" }, 2, { refuseTermed: true }).outcome).toBe("resolved");
  });
});
