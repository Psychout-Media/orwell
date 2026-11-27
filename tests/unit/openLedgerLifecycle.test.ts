import { describe, it, expect, vi } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { buildBeatAnnouncements } from "../../src/engine/beatAnnouncement";
import {
  OPEN_LEDGER_BRIEF_MAX, OPEN_LEDGER_MAX_ENTRIES, closeOpenEntry, emptyOpenLedger, flagOpenEntriesDue, openLedgerDueEntries, openLedgerSection,
  openLedgerLinkable, openLedgerSuperset, recordOpenEntry, resolveOpenEntry, restoreOpenLedger, settleOpenEntryDue, syncOpenLedger,
  type OpenLedger, type OpenLedgerEntry, type OpenLedgerProposal,
} from "../../src/engine/openLedger";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * ORW-448 - the engine closes open-ledger entries it knows are over (eviction, a linked deal, age), flags entries due after a
 * public ceremony, and gives each houseguest present a line. Roles only: the player, houseguest A, B ...; never names.
 * The pure helpers are tested directly; the engine wiring is tested on a REAL seeded season driven through the registry's commit funnel.
 */

type Priv = {
  openLedger: OpenLedger; live: { week: number; dayNumber?: number; beat: string; hoh?: string; evictionOrder: string[]; active: string[]; playedGame?: boolean; pending?: unknown; finished?: boolean };
  deals: { all: Array<{ id: string; status: string; parties: string[]; sealedBallot?: boolean }> };
  persist(): void; flagLedgerDue(f: unknown): void;
};
const priv = (g: GameSessionAdapter): Priv => g as unknown as Priv;
const ME = "player";

// ── pure fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
const entry = (over: Partial<OpenLedgerEntry> = {}): OpenLedgerEntry => ({
  id: "open:1", text: "I will vote with you", speaker: "npc:a", addressedTo: [ME], kind: "promise",
  turn: 3, beatSeq: 7, room: "kitchen", witnesses: ["npc:a", ME], quoteHash: "h1", status: "open", ...over,
});
const led = (...entries: OpenLedgerEntry[]): OpenLedger => ({ nextId: entries.length + 1, entries });
const ctx = (over: Partial<Parameters<typeof syncOpenLedger>[1]> = {}) => ({ turn: 50, gone: new Set<string>(), ...over });
const prop = (text: string, speaker = "npc:a", to: string[] = [ME]): OpenLedgerProposal => ({ text, speaker, addressedTo: to, kind: "promise" });
const here = (...ids: string[]) => ({ turn: 1, beatSeq: 1, room: "kitchen", witnesses: ids });

// ── PART 1: eviction ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("part 1: a houseguest who left the house closes their open entries (pure)", () => {
  const ledger = led(
    entry({ id: "open:1", speaker: "npc:a" }),                                            // A is the speaker
    entry({ id: "open:2", speaker: ME, addressedTo: ["npc:a"], quoteHash: "h2" }),        // A is the addressee
    entry({ id: "open:3", speaker: "npc:b", addressedTo: [], parties: ["npc:b", "npc:a", ME], quoteHash: "h3" }), // A is a party of a group pact
    entry({ id: "open:4", speaker: "npc:b", addressedTo: [ME], about: "npc:a", quoteHash: "h4" }), // only ABOUT A
    entry({ id: "open:5", speaker: "npc:b", addressedTo: [ME], quoteHash: "h5" }),        // somebody else's
  );
  it("withdraws A's speaker, addressee and group entries as 'left the house'; leaves an about-only entry and others open", () => {
    const out = syncOpenLedger(ledger, ctx({ gone: new Set(["npc:a"]) }));
    const by = (id: string) => out.entries.find((e) => e.id === id)!;
    for (const id of ["open:1", "open:2"]) expect(by(id)).toMatchObject({ status: "withdrawn", note: "left the house", resolvedTurn: 50 });
    expect(by("open:3")).toMatchObject({ status: "withdrawn", note: "one of them left the house", resolvedTurn: 50 }); // a group pact: not everyone left
    expect(by("open:4").status).toBe("open");
    expect(by("open:5").status).toBe("open");
    expect(out.entries).toHaveLength(5); // nothing deleted
  });
  it("the player's own eviction closes nothing", () => {
    expect(syncOpenLedger(ledger, ctx({ gone: new Set([ME]) }))).toBe(ledger);
  });
  it("is an ordinary open -> resolved change for the integrity rule", () => {
    expect(openLedgerSuperset(ledger, syncOpenLedger(ledger, ctx({ gone: new Set(["npc:a"]) })))).toBe(true);
  });
});

// ── PART 4: age-out (pure) ───────────────────────────────────────────────────────────────────────────────────────────────
describe("part 4: an open entry untouched for 7 in-game days lapses (pure)", () => {
  const born = (day: number): OpenLedger => recordOpenEntry(emptyOpenLedger(), prop("words one"), { ...here("npc:a"), day }).ledger;
  it("lapses 7 days after creation, not before", () => {
    const l = born(3);
    expect(syncOpenLedger(l, ctx({ day: 9 }))).toBe(l); // 6 days: still open
    const out = syncOpenLedger(l, ctx({ day: 10 }));
    expect(out.entries[0]).toMatchObject({ status: "lapsed", note: "not mentioned again", resolvedTurn: 50 });
  });
  it("re-stating it on day 6 moves the deadline to day 13", () => {
    const l = born(3);
    const r = recordOpenEntry(l, prop("words one"), { ...here("npc:a"), day: 6, beatSeq: 9 });
    expect(r.outcome).toBe("duplicate");
    expect(r.ledger.touched).toEqual({ "open:1": 6 });
    expect(syncOpenLedger(r.ledger, ctx({ day: 12 }))).toBe(r.ledger);
    expect(syncOpenLedger(r.ledger, ctx({ day: 13 })).entries[0]!.status).toBe("lapsed");
  });
  it("an entry saved with no day is stamped on first sight and lapses 7 days after that; the entry itself is untouched", () => {
    const l = led(entry());
    const first = syncOpenLedger(l, ctx({ day: 20 }));
    expect(first.touched).toEqual({ "open:1": 20 });
    expect(first.entries[0]).toEqual(l.entries[0]);
    expect(syncOpenLedger(first, ctx({ day: 26 }))).toBe(first);
    expect(syncOpenLedger(first, ctx({ day: 27 })).entries[0]!.status).toBe("lapsed");
  });
  it("saying a lapsed thing again records a NEW entry, even inside the 30-beat window", () => {
    const lapsed = syncOpenLedger(born(1), ctx({ day: 8, turn: 20 }));
    expect(lapsed.entries[0]!.status).toBe("lapsed");
    const again = recordOpenEntry(lapsed, prop("words one"), { ...here("npc:a"), day: 8, beatSeq: 21 });
    expect(again.outcome).toBe("recorded");
    expect(again.ledger.entries).toHaveLength(2);
    // a different kind of resolution still counts as a duplicate inside the window (unchanged rule)
    const kept = closeOpenEntry(born(1), "open:1", "kept", "x", 20);
    expect(recordOpenEntry(kept, prop("words one"), { ...here("npc:a"), day: 8, beatSeq: 21 }).outcome).toBe("duplicate");
  });
  it("`lapsed` cannot be set by a resolution request", () => {
    const l = born(1);
    const r = resolveOpenEntry(l, { entryId: "open:1", status: "lapsed", note: "x" }, 5);
    expect(r.outcome).toBe("bad-status");
    expect(r.ledger).toBe(l);
  });
  it("a lapsed entry leaves the brief at once (not after 30 beats) and stays in the ledger", () => {
    const l = syncOpenLedger(born(1), ctx({ day: 8, turn: 20 }));
    expect(openLedgerSection(l, ["npc:a"], (id) => id, 21)).toBeUndefined();
    expect(openLedgerSection(l, ["npc:a"], (id) => id)).toBeUndefined();
    expect(l.entries).toHaveLength(1);
    const kept = closeOpenEntry(born(1), "open:1", "kept", "x", 20);
    expect(openLedgerSection(kept, ["npc:a"], (id) => id, 21)).toContain("[kept");
  });
});

// ── ORW-1093: the cap never drops a present houseguest ──
describe("ORW-1093: more houseguests present with something open than the cap holds", () => {
  it("every one of them still gets an entry, and nothing else is added", () => {
    const people = ["npc:a", "npc:b", "npc:c", "npc:d", "npc:e", "npc:f", "npc:g", "npc:h"];
    const entries: OpenLedgerEntry[] = people.map((p, i) => entry({ id: `open:${i + 1}`, speaker: p, text: `old words of ${p}`, quoteHash: `o${i}` }));
    entries.push(entry({ id: "open:9", speaker: "npc:a", text: "newer words of the first", quoteHash: "n0" }));
    const lines = openLedgerSection({ nextId: 10, entries }, people, (id) => id, 100)!.split("\n").slice(1);
    expect(people.length).toBeGreaterThan(OPEN_LEDGER_BRIEF_MAX);
    expect(lines).toHaveLength(people.length);
    for (const p of people.slice(1)) expect(lines.some((l) => l.includes(`old words of ${p}`)), p).toBe(true);
    expect(lines.some((l) => l.includes("newer words of the first"))).toBe(true);
  });
});

// ── PART 5: one line per houseguest present ──────────────────────────────────────────────────────────────────────────────
describe("part 5: each houseguest present with an open entry gets a line (pure)", () => {
  it("five present houseguests each with an old entry, plus five newer entries about two of them: every one has a line", () => {
    const people = ["npc:a", "npc:b", "npc:c", "npc:d", "npc:e"];
    const entries: OpenLedgerEntry[] = people.map((p, i) => entry({ id: `open:${i + 1}`, speaker: p, text: `old words of ${p}`, quoteHash: `o${i}` }));
    for (let i = 0; i < 5; i++) entries.push(entry({ id: `open:${6 + i}`, speaker: i % 2 ? "npc:a" : "npc:b", text: `newer words ${i}`, quoteHash: `n${i}` }));
    const ledger = { nextId: 11, entries };
    const out = openLedgerSection(ledger, people, (id) => id, 100)!;
    const lines = out.split("\n").slice(1);
    expect(lines).toHaveLength(OPEN_LEDGER_BRIEF_MAX);
    for (const p of people) expect(lines.some((l) => l.includes(`old words of ${p}`) || (p === "npc:a" && l.includes("newer words 3")) || (p === "npc:b" && l.includes("newer words 4"))), p).toBe(true);
    // the three with only an old entry are all shown by their old entry
    for (const p of ["npc:c", "npc:d", "npc:e"]) expect(out).toContain(`old words of ${p}`);
  });
  it("with nobody having more than one entry the result is today's ranking; the cap and a line's text are unchanged", () => {
    const ledger = led(entry({ id: "open:1" }), entry({ id: "open:2", quoteHash: "x", text: "second" }));
    const out = openLedgerSection(ledger, ["npc:a"], (id) => id)!;
    expect(out.split("\n")[1]).toContain("second"); // newest first
    expect(out.split("\n")).toHaveLength(3);
  });
});

// ── PART 3 (pure): due flags ─────────────────────────────────────────────────────────────────────────────────────────────
describe("part 3: the due flag (pure)", () => {
  const ledger = led(
    entry({ id: "open:1", speaker: "npc:a" }),
    entry({ id: "open:2", speaker: ME, addressedTo: ["npc:a"], quoteHash: "h2" }),
    entry({ id: "open:3", speaker: "npc:b", addressedTo: [ME], about: "npc:a", quoteHash: "h3" }),
    entry({ id: "open:4", speaker: "npc:b", addressedTo: [ME], quoteHash: "h4" }),
    entry({ id: "open:5", speaker: "npc:a", status: "kept", note: "n", resolvedTurn: 2, quoteHash: "h5" }),
  );
  it("flags exactly the open entries whose parties include the actor, not about-only, not resolved, never for the player", () => {
    const out = flagOpenEntriesDue(ledger, ["npc:a"], "Public result: X");
    expect(Object.keys(out.due!).sort()).toEqual(["open:1", "open:2"]);
    expect(flagOpenEntriesDue(ledger, [ME], "x")).toBe(ledger);
    expect(openLedgerSuperset(ledger, out)).toBe(true);
  });
  it("keeps the first line when flagged again, and returns at most 3 due entries, newest entry first", () => {
    const a = flagOpenEntriesDue(ledger, ["npc:a"], "first");
    expect(flagOpenEntriesDue(a, ["npc:a"], "second")).toBe(a);
    const many = led(...Array.from({ length: 5 }, (_, i) => entry({ id: `open:${i + 1}`, quoteHash: `q${i}`, text: `w${i}` })));
    const flagged = flagOpenEntriesDue(many, ["npc:a"], "L");
    expect(openLedgerDueEntries(flagged).map((d) => d.e.id)).toEqual(["open:5", "open:4", "open:3"]);
  });
  it("is judged once (`offered`), survives a failed pass, and is dropped after the third failed offer", () => {
    const flagged = flagOpenEntriesDue(ledger, ["npc:a"], "L");
    const done = settleOpenEntryDue(flagged, "open:1", "offered")!;
    expect(Object.keys(done.due!)).toEqual(["open:2"]);
    let l: OpenLedger = flagged;
    l = settleOpenEntryDue(l, "open:1", "unjudged")!; expect(l.due!["open:1"]!.offers).toBe(1);
    l = settleOpenEntryDue(l, "open:1", "unjudged")!; expect(l.due!["open:1"]!.offers).toBe(2);
    l = settleOpenEntryDue(l, "open:1", "unjudged")!; expect(l.due!["open:1"]).toBeUndefined();
    expect(settleOpenEntryDue(l, "open:1", "offered")).toBeNull();
  });
  it("a resolution (the model's or the engine's) drops the flag", () => {
    const flagged = flagOpenEntriesDue(ledger, ["npc:a"], "L");
    const r = resolveOpenEntry(flagged, { entryId: "open:1", status: "kept", note: "n" }, 9).ledger;
    expect(r.due!["open:1"]).toBeUndefined();
    expect(openLedgerSuperset(flagged, r)).toBe(true);
    expect(closeOpenEntry(flagged, "open:2", "lapsed", "x", 9).due!["open:2"]).toBeUndefined();
  });
});

// ── integrity ────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("integrity: every new field passes openLedgerSuperset, tampering is refused", () => {
  const base = (): OpenLedger => {
    let l = recordOpenEntry(emptyOpenLedger(), prop("one"), { ...here("npc:a"), day: 2, dealId: "deal:1" }).ledger;
    l = recordOpenEntry(l, prop("two", "npc:b"), { ...here("npc:b"), day: 2 }).ledger;
    return l;
  };
  it("accepts lapsed, a deal link, due data and a touched day (growing)", () => {
    const a = base();
    expect(a.entries[0]).toMatchObject({ day: 2, dealId: "deal:1" });
    const touched = recordOpenEntry(a, prop("one"), { ...here("npc:a"), day: 5, beatSeq: 9 }).ledger;
    expect(openLedgerSuperset(a, touched)).toBe(true);
    const due = flagOpenEntriesDue(touched, ["npc:a"], "L");
    expect(openLedgerSuperset(touched, due)).toBe(true);
    expect(openLedgerSuperset(due, settleOpenEntryDue(due, "open:1", "unjudged")!)).toBe(true);
    expect(openLedgerSuperset(due, closeOpenEntry(due, "open:1", "lapsed", "not mentioned again", 9))).toBe(true);
    expect(openLedgerSuperset(due, closeOpenEntry(due, "open:1", "withdrawn", "left the house", 9))).toBe(true);
  });
  it.each([
    ["removing an entry", (l: OpenLedger) => ({ ...l, entries: l.entries.slice(1) })],
    ["changing text", (l: OpenLedger) => ({ ...l, entries: l.entries.map((e, i) => (i ? e : { ...e, text: "other" })) })],
    ["rewriting the deal link", (l: OpenLedger) => ({ ...l, entries: l.entries.map((e, i) => (i ? e : { ...e, dealId: "deal:9" })) })],
    ["rewriting the creation day", (l: OpenLedger) => ({ ...l, entries: l.entries.map((e, i) => (i ? e : { ...e, day: 1 })) })],
    ["un-resolving", (l: OpenLedger) => ({ ...l, entries: l.entries.map((e) => ({ ...e, status: "open" as const })) })],
  ])("refuses %s", (_n, tamper) => {
    const closed = closeOpenEntry(base(), "open:1", "lapsed", "not mentioned again", 4);
    const a = _n === "un-resolving" ? closed : base();
    expect(openLedgerSuperset(a, tamper(a))).toBe(false);
  });
  it("refuses moving a touched day backwards or dropping one", () => {
    const a = recordOpenEntry(base(), prop("one"), { ...here("npc:a"), day: 6, beatSeq: 9 }).ledger;
    expect(a.touched).toEqual({ "open:1": 6 });
    expect(openLedgerSuperset(a, { ...a, touched: { "open:1": 5 } })).toBe(false);
    const { touched: _t, ...none } = a;
    expect(openLedgerSuperset(a, none)).toBe(false);
    expect(openLedgerSuperset(a, { ...a, touched: { "open:1": 8 } })).toBe(true);
    expect(openLedgerSuperset(a, { ...a, touched: { ...a.touched, "open:77": 8 } })).toBe(false); // a day for an entry that does not exist
  });
  it("refuses an edited due line, a lowered offer count, and a due flag on a resolved or unknown entry", () => {
    const due = flagOpenEntriesDue(settleOpenEntryDue(flagOpenEntriesDue(base(), ["npc:a"], "L"), "open:1", "unjudged")!, [], "x");
    expect(due.due!["open:1"]!.offers).toBe(1);
    expect(openLedgerSuperset(due, { ...due, due: { "open:1": { line: "L2", offers: 1 } } })).toBe(false);
    expect(openLedgerSuperset(due, { ...due, due: { "open:1": { line: "L", offers: 0 } } })).toBe(false);
    expect(openLedgerSuperset(due, { ...due, due: { "open:9": { line: "L", offers: 0 } } })).toBe(false);
    const closed = closeOpenEntry(due, "open:1", "kept", "x", 3);
    expect(openLedgerSuperset(due, { ...closed, due: { "open:1": { line: "L", offers: 1 } } })).toBe(false);
  });
  it("an old save without any new field loads and re-saves byte-identically; a malformed side map locks as a problem", () => {
    const old = { nextId: 3, entries: [{ id: "open:1", text: "x", speaker: "npc:1", addressedTo: ["player"], kind: "promise", turn: 2, beatSeq: 2, room: "kitchen", witnesses: ["npc:1", "player"], quoteHash: "h", status: "open" },
      { id: "open:2", text: "y", speaker: "npc:1", addressedTo: ["player"], kind: "claim", turn: 2, beatSeq: 2, room: "kitchen", witnesses: ["npc:1", "player"], quoteHash: "h2", status: "kept", note: "n", resolvedTurn: 4 }] };
    const r = restoreOpenLedger(JSON.parse(JSON.stringify(old)));
    expect(r.problems).toBe(0);
    expect(JSON.stringify(r.ledger)).toBe(JSON.stringify(old));
    expect(syncOpenLedger(r.ledger, { turn: 1, gone: new Set() })).toBe(r.ledger); // no day known: nothing is stamped
    expect(restoreOpenLedger({ ...old, touched: { "open:1": "x" } }).problems).toBe(1);
    expect(restoreOpenLedger({ ...old, due: { "open:1": { line: 4, offers: 0 } } }).problems).toBe(1);
    const withNew = { ...old, touched: { "open:1": 4 }, due: { "open:1": { line: "L", offers: 1 } } };
    expect(JSON.stringify(restoreOpenLedger(JSON.parse(JSON.stringify(withNew))).ledger)).toBe(JSON.stringify(withNew));
  });
});

// ── the real engine ──────────────────────────────────────────────────────────────────────────────────────────────────────
type Run = { g: GameSessionAdapter; view: AdvanceView; runtime: ReturnType<typeof composeRuntime> };
const SEED = 4001; // the first week's Head of Household is a houseguest (not the player) on this seed

/** Answer whatever is pending, or advance. */
function step(g: GameSessionAdapter, v: AdvanceView): AdvanceView {
  const p = v.pending;
  if (!p) return g.advanceGame();
  if (p.kind === "ceremony-step") return g.advanceGame();
  if (p.kind === "nominations") return g.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return g.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return g.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return g.submitDecision({ kind: p.kind, intent: "compete" });
  if (p.kind === "finale-answer") return g.submitDecision({ kind: "finale-answer", appeal: (p as { appeals?: string[] }).appeals![0]! } as never); // ORW-692: votes now differ, so this seed reaches the finale
  return g.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

/** A real seeded season, driven unplayed up to the first nominations, then handed to "a person is playing" (the ledger is for played games). */
function startAtNominations(seed = SEED): Run {
  const runtime = composeRuntime({ clock: new FakeClock() });
  const g = runtime.registry.sandboxFor(`orw448-${seed}`).session as unknown as GameSessionAdapter;
  g.createCharacter({ playerName: "P", seed });
  let view = g.advanceGame();
  for (let i = 0; i < 400 && !(priv(g).live.beat === "nominations" && !priv(g).live.pending); i++) view = step(g, view);
  priv(g).live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  (g as unknown as { setOwnViewEnabled(on: boolean): void }).setOwnViewEnabled(false); // ORW-574: the own view changes how many entries a season writes; this checks the ledger's bound, not the decisions
  (g as unknown as { setRoutinesEnabled(on: boolean): void }).setRoutinesEnabled(false); // ORW-651: routines move who is where, and so what a season's deals look like; these check the ledger, not behaviour
  return { g, view, runtime };
}
const npcs = (g: GameSessionAdapter): string[] => g.getGameState().house.map((h) => h.id as string).filter((id) => id !== ME);
/** Seed the ledger directly (the witnesses are not the point of these tests): one entry per houseguest, spoken to the player. */
function seedEntries(g: GameSessionAdapter, extra: Array<Partial<OpenLedgerEntry>> = []): void {
  const ids = npcs(g);
  const day = priv(g).live.dayNumber ?? priv(g).live.week;
  const entries: OpenLedgerEntry[] = ids.map((id, i) => entry({ id: `open:${i + 1}`, speaker: id, text: `words of ${id}`, quoteHash: `s${i}`, witnesses: [id, ME], day }));
  extra.forEach((x, i) => entries.push(entry({ id: `open:${ids.length + i + 1}`, quoteHash: `x${i}`, text: `extra ${i}`, day, ...x })));
  priv(g).openLedger = { nextId: entries.length + 1, entries };
}
const statusOf = (g: GameSessionAdapter, id: string) => priv(g).openLedger.entries.filter((e) => e.speaker === id || e.addressedTo.includes(id)).map((e) => e.status);
const dueIds = (g: GameSessionAdapter): string[] => Object.keys(priv(g).openLedger.due ?? {}).sort();
const strip = (g: GameSessionAdapter): string => { const s = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>; delete s.openLedger; return JSON.stringify(s); };

/** Advance until `stop` is true (checked before each step); returns the announcements seen. */
function runUntil(r: Run, stop: () => boolean, max = 600): string[] {
  const heard: string[] = [];
  for (let i = 0; i < max && !stop() && !priv(r.g).live.finished; i++) {
    r.view = step(r.g, r.view);
    for (const a of r.view.announcements ?? []) heard.push(`${a.kind}: ${a.headline}`);
  }
  return heard;
}

describe("part 1 (real engine): the eviction closes the evictee's entries inside its own commit", () => {
  it("withdraws the evictee's open entries as 'left the house', leaves entries only about them and everyone else's open, and adds no save or beat", () => {
    const a = startAtNominations(); const b = startAtNominations();
    npcs(b.g); // the same reads on both (a read can seat the house)
    seedEntries(a.g, [{ speaker: ME, addressedTo: [] , about: "npc:1" }]);
    const weekOne = (r: Run): void => { runUntil(r, () => priv(r.g).live.evictionOrder.length >= 1); };
    weekOne(a); weekOne(b);
    const gone = priv(a.g).live.evictionOrder[0]!;
    expect(gone).not.toBe(ME);
    for (const e of priv(a.g).openLedger.entries) {
      if (e.speaker === gone) expect(e, "the evictee's entry").toMatchObject({ status: "withdrawn", note: "left the house" });
      else expect(e.status, `${e.id} stays open`).toBe("open");
    }
    expect(priv(a.g).openLedger.entries).toHaveLength(npcs(a.g).length + 1);
    // an entry only ABOUT the evictee stays open
    const about = { ...entry({ id: "x" }), about: gone };
    expect(syncOpenLedger(led(about), ctx({ gone: new Set([gone]) })).entries[0]!.status).toBe("open");
    // the same eviction with no ledger at all: the beat counter and every other byte of the save are identical
    expect(a.g.beatSeqNow()).toBe(b.g.beatSeqNow());
    a.g.whereabouts(); b.g.whereabouts(); const sa = strip(a.g); const sb = strip(b.g);
    if (sa !== sb) { let i = 0; while (sa[i] === sb[i]) i++; throw new Error(`differs at ${i}: ${sa.slice(i - 200, i + 200)} /// ${sb.slice(i - 200, i + 200)}`); }
  });
  it("the player's own eviction closes nothing (engine wiring)", () => {
    const { g } = startAtNominations();
    seedEntries(g);
    const before = priv(g).openLedger;
    priv(g).live.evictionOrder.push(ME);
    priv(g).persist();
    expect(priv(g).openLedger).toEqual(before);
    expect(priv(g).openLedger.entries.every((e) => e.status === "open")).toBe(true);
  });
});

describe("part 3 (real engine): after a public ceremony the relevant entries come due", () => {
  it("nominations: exactly the entries whose parties include the Head of Household, with a line of public facts only; judged once", () => {
    const r = startAtNominations();
    const hoh = priv(r.g).live.hoh!;
    expect(hoh).not.toBe(ME);
    seedEntries(r.g, [{ speaker: "npc:99", addressedTo: [ME], about: hoh }, { speaker: ME, addressedTo: [hoh], quoteHash: "to-hoh" }]);
    const heard = runUntil(r, () => dueIds(r.g).length > 0 || priv(r.g).live.beat !== "nominations");
    const noms = heard.find((h) => h.startsWith("nominations:"))!;
    const named = noms.replace("nominations: ", "");
    const want = priv(r.g).openLedger.entries.filter((e) => e.status === "open" && (e.speaker === hoh || e.addressedTo.includes(hoh))).map((e) => e.id).sort();
    expect(want.length).toBe(2);
    expect(dueIds(r.g)).toEqual(want);
    const line = priv(r.g).openLedger.due![want[0]!]!.line;
    expect(line).toBe(`Public result of the nominations: ${named}`);
    expect(line).not.toMatch(/vote|ballot|trust|affinity|threat/i);
    // returned first by openLedgerHere even when none of its people is here
    // let the ceremony pass until the Head of Household is not in the player's room (the flag stands: nothing has judged it)
    for (let i = 0; i < 60 && r.g.whereabouts()!.present.some((p) => p.id === hoh); i++) { r.view = step(r.g, r.view); r.g.movePlayer("bathroom"); }
    expect(r.g.whereabouts()!.present.some((p) => p.id === hoh), "the Head of Household is elsewhere").toBe(false);
    expect(dueIds(r.g)).toEqual(want);
    const list = r.g.openLedgerHere();
    expect(list.slice(0, 2).map((x) => x.id).sort()).toEqual(want);
    expect(list.slice(0, 2).every((x) => x.due === line)).toBe(true);
    expect(list.length).toBeLessThanOrEqual(6);
    expect(list.slice(2).every((x) => x.due === undefined)).toBe(true);
    // offered and judged: no longer due
    expect(r.g.resolveOpenLedger({ entryId: want[0]!, status: "offered", note: "" })).toEqual({ accepted: true });
    expect(r.g.resolveOpenLedger({ entryId: want[1]!, status: "kept", note: "he did" })).toEqual({ accepted: true });
    expect(dueIds(r.g)).toEqual([]);
    expect(r.g.openLedgerHere().every((x) => x.due === undefined)).toBe(true);
    expect(priv(r.g).openLedger.entries.find((e) => e.id === want[0])!.status).toBe("open"); // judging once is not resolving
  });

  it("a failed judgment pass keeps the flag, bounded to 3 offers", () => {
    const r = startAtNominations();
    seedEntries(r.g);
    runUntil(r, () => dueIds(r.g).length > 0);
    const id = dueIds(r.g)[0]!;
    for (let n = 1; n <= 2; n++) {
      expect(r.g.resolveOpenLedger({ entryId: id, status: "unjudged", note: "" })).toEqual({ accepted: true });
      expect(dueIds(r.g)).toContain(id);
      expect(r.g.openLedgerHere().some((x) => x.id === id && x.due)).toBe(true);
    }
    expect(r.g.resolveOpenLedger({ entryId: id, status: "unjudged", note: "" })).toEqual({ accepted: true });
    expect(dueIds(r.g)).not.toContain(id);
    expect(r.g.resolveOpenLedger({ entryId: id, status: "offered", note: "" })).toEqual({ accepted: false, reason: "not-due" });
  });

  it("the veto ceremony: the veto holder's entries come due with the veto result line", () => {
    const r = startAtNominations();
    seedEntries(r.g);
    runUntil(r, () => dueIds(r.g).length > 0); // nominations
    for (const id of dueIds(r.g)) r.g.resolveOpenLedger({ entryId: id, status: "offered", note: "" });
    const heard = runUntil(r, () => dueIds(r.g).length > 0 || priv(r.g).live.beat === "eviction");
    const veto = heard.find((h) => h.startsWith("veto-decision:"))!.replace("veto-decision: ", "");
    expect(veto).toBeTruthy();
    const line = Object.values(priv(r.g).openLedger.due ?? {})[0]!.line;
    expect(line).toBe(`Public result of the veto ceremony: ${veto}`);
  });

  it("an eviction closes the evictee's entries (part 1) and flags nobody for how they voted; ballots never reach a due line", () => {
    const r = startAtNominations();
    seedEntries(r.g);
    runUntil(r, () => dueIds(r.g).length > 0);
    for (const id of dueIds(r.g)) r.g.resolveOpenLedger({ entryId: id, status: "offered", note: "" });
    const hoh = priv(r.g).live.hoh!;
    const heard = runUntil(r, () => { // judge every flag as it comes, except in the eviction itself
      if (priv(r.g).live.beat !== "eviction") for (const id of dueIds(r.g)) r.g.resolveOpenLedger({ entryId: id, status: "offered", note: "" });
      return priv(r.g).live.evictionOrder.length >= 1;
    });
    const result = heard.find((h) => h.startsWith("eviction-result:"))!;
    const ballots = heard.filter((h) => h.startsWith("eviction-ballot:"));
    expect(ballots.length).toBeGreaterThan(0);
    const lines = Object.values(priv(r.g).openLedger.due ?? {}).map((d) => d.line).filter((l) => l.startsWith("Public result of the eviction"));
    for (const l of lines) {
      expect(l).toBe(`Public result of the eviction: ${result.replace("eviction-result: ", "")}`);
      expect(l).toMatch(/Head of Household broke a tied vote/);
    }
    // every entry that is due belongs to the Head of Household, and only in a tie; with no tie nothing is due
    const evictionDue = Object.entries(priv(r.g).openLedger.due ?? {}).filter(([, d]) => d.line.startsWith("Public result of the eviction")).map(([id]) => id);
    for (const id of evictionDue) expect(priv(r.g).openLedger.entries.find((e) => e.id === id)!.speaker).toBe(hoh);
    // no conditional: the eviction flags entries if and only if the public result says the Head of Household broke a tie
    expect(evictionDue.length > 0).toBe(result.includes("tied vote"));
  });

  it("the due set and lines do not change with how individuals voted, given the same public outcome (two hidden ballot patterns)", () => {
    // A tied vote, evictee E: the Head of Household breaks it. Same evictee, same count; the hidden ballots differ.
    const mk = (voteOf: Record<string, string>) => {
      const r = startAtNominations();
      const live = priv(r.g).live as unknown as Record<string, unknown>;
      const [x, y] = ["npc:3", "npc:4"];
      seedEntries(r.g, [
        { speaker: "npc:5", addressedTo: [ME], quoteHash: "v5" }, { speaker: "npc:6", addressedTo: [ME], quoteHash: "v6" },
        { speaker: "npc:7", addressedTo: [ME], quoteHash: "v7" }, { speaker: "npc:8", addressedTo: [ME], quoteHash: "v8" },
      ]);
      live.hoh = "npc:2";
      live.eviction = { nominees: [x, y], voteOf, stage: "votes" };
      const ev = { beat: "eviction", participants: [x], content: "", week: 1 } as never;
      priv(r.g).flagLedgerDue(buildBeatAnnouncements(ev, live as never));
      return { due: priv(r.g).openLedger.due ?? {}, g: r.g };
    };
    const one = mk({ "npc:5": "npc:3", "npc:6": "npc:4", "npc:7": "npc:3", "npc:8": "npc:4" });
    const two = mk({ "npc:5": "npc:4", "npc:6": "npc:3", "npc:7": "npc:4", "npc:8": "npc:3" });
    expect(Object.keys(one.due).length).toBeGreaterThan(0);
    expect(JSON.stringify(one.due)).toBe(JSON.stringify(two.due));
    const text = JSON.stringify(Object.values(one.due));
    for (const voter of ["npc:5", "npc:6", "npc:7", "npc:8"]) expect(text).not.toContain(voter);
    for (const id of Object.keys(one.due)) expect(priv(one.g).openLedger.entries.find((e) => e.id === id)!.speaker).toBe("npc:2");
    for (const l of Object.values(one.due)) expect(l.line).toMatch(/^Public result of the eviction: .* has been evicted from the house after the Head of Household broke a tied vote\.$/);
    // no tie (3 to 1 for the same evictee): nothing at all is due, whoever voted how
    const three = mk({ "npc:5": "npc:3", "npc:6": "npc:3", "npc:7": "npc:3", "npc:8": "npc:4" });
    expect(three.due).toEqual({});
  });
});

describe("part 2 (real engine): an entry linked to an engine deal closes with the deal's PUBLIC ending", () => {
  function withDeal(): { g: GameSessionAdapter; id: string; deal: Priv["deals"]["all"][number]; other: string } {
    const { g } = startAtNominations();
    g.noteMessage({ messageId: "m-deal" });
    const [who, other] = npcs(g);
    const made = g.makeDeal({ with: who as never, kind: "safety", terms: "a safe week" });
    if (!made || "refused" in made) throw new Error("the deal was not made");
    const wa = g.movePlayer("living-room")!;
    expect(wa.present.some((p) => p.id === who)).toBe(true);
    const r = g.recordOpenLedger({ text: "I will keep you safe this week", speaker: who, addressedTo: [ME], kind: "pact" });
    expect(r).toMatchObject({ accepted: true });
    const deal = priv(g).deals.all.find((d) => d.id === made.id)!;
    return { g, id: r.entryId!, deal, other: other! };
  }
  const entryOf = (g: GameSessionAdapter, id: string) => priv(g).openLedger.entries.find((e) => e.id === id)!;

  it("stores the id of an active deal between exactly those two people made this turn", () => {
    const { g, id, deal } = withDeal();
    expect(entryOf(g, id).dealId).toBe(deal.id);
  });
  it("does not link an entry with a different person, a group, or a deal that is not recent", () => {
    const { g, deal } = withDeal();
    const wa = g.whereabouts()!;
    const others = wa.present.map((p) => p.id as string).filter((p) => p !== ME && p !== deal.parties.find((x) => x !== ME));
    if (others[0]) {
      const r = g.recordOpenLedger({ text: "someone else's promise", speaker: others[0], addressedTo: [ME], kind: "pact" });
      expect(entryOf(g, r.entryId!).dealId).toBeUndefined();
    }
    for (let i = 0; i < 5; i++) { g.noteMessage({ messageId: `m-${i}` }); priv(g).persist(); (g as unknown as { bumpBeatSeq(): void }).bumpBeatSeq(); }
    const partner = deal.parties.find((x) => x !== ME)!;
    const late = g.recordOpenLedger({ text: "a much later promise", speaker: partner, addressedTo: [ME], kind: "pact" });
    expect(entryOf(g, late.entryId!).dealId).toBeUndefined();
  });
  it("kept: the entry closes as kept with a fixed note; broken: as broken", () => {
    for (const status of ["kept", "broken"] as const) {
      const { g, id, deal } = withDeal();
      deal.status = status;
      priv(g).persist();
      expect(entryOf(g, id)).toMatchObject({ status, note: `the linked deal ended as ${status}` });
    }
  });
  it("a break the player is not shown (a sealed ballot) does NOT close the entry; a deal still open does not either", () => {
    const { g, id, deal } = withDeal();
    priv(g).persist();
    expect(entryOf(g, id).status).toBe("open");
    deal.status = "broken"; deal.sealedBallot = true;
    priv(g).persist();
    expect(entryOf(g, id).status).toBe("open");
  });
  it("ORW-456: a deal that LAPSES (an untested term ran out, or a renegotiation replaced it) is not a verdict, but its line closes with it", () => {
    const { g, id, deal } = withDeal();
    priv(g).persist();
    deal.status = "lapsed";
    priv(g).persist();
    expect(entryOf(g, id)).toMatchObject({ status: "lapsed", note: "the linked deal lapsed or was replaced" });
  });
  it("an unlinked entry is untouched by any deal ending", () => {
    const { g, deal } = withDeal();
    const partner = deal.parties.find((x) => x !== ME)!;
    const unlinked = recordOpenEntry(priv(g).openLedger, prop("unlinked words", partner), { ...here(partner), day: 1 });
    priv(g).openLedger = unlinked.ledger;
    deal.status = "kept"; priv(g).persist();
    expect(entryOf(g, unlinked.id!).status).toBe("open");
  });
});

describe("part 4 (real engine): the lapse happens at the day roll, inside that commit", () => {
  it("an entry nobody touched lapses 7 in-game days after it was made, and not before", () => {
    const r = startAtNominations();
    const res = r.g.recordOpenLedger({ text: "a plan for the week", speaker: ME, addressedTo: [], kind: "plan", about: "the next competition" });
    expect(res).toMatchObject({ accepted: true });
    const id = res.entryId!;
    const e0 = priv(r.g).openLedger.entries[0]!;
    expect(e0.day).toBe(priv(r.g).live.dayNumber); // the in-game day only: no stand-in (undefined stays undefined)
    const stamp = (): number | undefined => priv(r.g).openLedger.entries[0]!.day ?? priv(r.g).openLedger.touched?.[id];
    runUntil(r, () => stamp() !== undefined);
    const day0 = stamp()!; // the day it was first seen
    runUntil(r, () => (priv(r.g).live.dayNumber ?? 0) >= day0 + 6);
    expect(priv(r.g).openLedger.entries.find((e) => e.id === id)!.status).toBe("open");
    const before = r.g.beatSeqNow();
    runUntil(r, () => (priv(r.g).live.dayNumber ?? 0) >= day0 + 7);
    const e = priv(r.g).openLedger.entries.find((x) => x.id === id)!;
    expect(e).toMatchObject({ status: "lapsed", note: "not mentioned again" });
    expect(r.g.beatSeqNow()).toBeGreaterThan(before);
    expect(JSON.stringify(r.g.snapshot())).toContain("a plan for the week"); // still in the save
    expect(r.g.openLedgerHere().some((x) => x.id === id)).toBe(false);
    expect(r.g.getMomentPrompt({ brief: {} }).showBrief?.text ?? "").not.toContain("a plan for the week");
  });
  it("re-stating it on day 6 moves the deadline", () => {
    const r = startAtNominations();
    const res = r.g.recordOpenLedger({ text: "a plan for the week", speaker: ME, addressedTo: [], kind: "plan", about: "the next competition" });
    const id0 = res.entryId!;
    runUntil(r, () => (priv(r.g).openLedger.entries[0]!.day ?? priv(r.g).openLedger.touched?.[id0]) !== undefined);
    const day0 = (priv(r.g).openLedger.entries[0]!.day ?? priv(r.g).openLedger.touched?.[id0])!;
    runUntil(r, () => (priv(r.g).live.dayNumber ?? 0) >= day0 + 6);
    expect(r.g.recordOpenLedger({ text: "a plan for the week", speaker: ME, addressedTo: [], kind: "plan", about: "the next competition" })).toMatchObject({ accepted: true, duplicate: true });
    const touchedDay = priv(r.g).openLedger.touched![res.entryId!]!;
    expect(touchedDay).toBeGreaterThanOrEqual(day0 + 6);
    runUntil(r, () => (priv(r.g).live.dayNumber ?? 0) >= day0 + 7);
    expect(priv(r.g).openLedger.entries[0]!.status).toBe("open");
    runUntil(r, () => (priv(r.g).live.dayNumber ?? 0) >= touchedDay + 7);
    expect(priv(r.g).openLedger.entries[0]!.status).toBe("lapsed");
  });
  it("an entry from an old save (no day) is stamped when first loaded and lapses 7 days after; loading and re-saving alone changes nothing", () => {
    const r = startAtNominations();
    seedEntries(r.g);
    const old = JSON.parse(JSON.stringify(r.g.snapshot())) as SessionSnapshot & { openLedger: OpenLedger };
    for (const e of old.openLedger.entries as unknown as Array<Record<string, unknown>>) delete e.day;
    const fresh = composeRuntime({ clock: new FakeClock() }).registry.sandboxFor("orw448-old").session as unknown as GameSessionAdapter;
    fresh.restore(JSON.parse(JSON.stringify(old)));
    expect(JSON.stringify(fresh.snapshot().openLedger)).toBe(JSON.stringify(old.openLedger)); // byte-identical re-save
    expect(JSON.stringify(fresh.snapshot())).toBe(JSON.stringify(old));
    // nobody is evicted in these days: use entries with no houseguest party so only age acts
    priv(fresh).openLedger = { nextId: 2, entries: [entry({ id: "open:1", speaker: ME, addressedTo: [], about: "the next competition", witnesses: [ME] })] };
    priv(fresh).live.playedGame = true; fresh.setAdvanceGateEnabled(false);
    priv(fresh).persist();
    expect(priv(fresh).openLedger.touched?.["open:1"]).toBe(priv(fresh).live.dayNumber); // stamped with the in-game day, or not at all while there is none
    expect(priv(fresh).openLedger.entries[0]).toEqual(entry({ id: "open:1", speaker: ME, addressedTo: [], about: "the next competition", witnesses: [ME] }));
  });
});

describe("a simulated season: weekly evictions, several new entries a day, no model", () => {
  it("the open count never reaches the bound and nothing is ever removed from the snapshot", { timeout: 120_000 }, () => { // ORW-985: a whole simulated season: an explicit budget, not the 30 s default
    const r = startAtNominations(4002);
    const rng = new SeededRandom(448);
    let maxOpen = 0; let created = 0; let day = -1;
    let prev = JSON.parse(JSON.stringify(r.g.snapshot())) as SessionSnapshot;
    let guard = 0;
    while (!priv(r.g).live.finished && guard++ < 900) {
      const d = priv(r.g).live.dayNumber ?? 0;
      if (d !== day) { // a new in-game day: several new entries among the people still in the house
        day = d;
        const wa = r.g.movePlayer(["living-room", "kitchen", "backyard", "bedroom", "bathroom"][rng.int(5)]!);
        const people = (wa?.present ?? []).map((p) => p.id as string).filter((x) => x !== ME);
        for (let k = 0; k < 14 && people.length; k++) {
          const who = people[rng.int(people.length)]!;
          const out = r.g.recordOpenLedger({ text: `claim ${created} by ${who}`, speaker: who, addressedTo: [ME], kind: "claim" });
          if (out.accepted) created++;
        }
      }
      r.view = step(r.g, r.view);
      const open = priv(r.g).openLedger.entries.filter((e) => e.status === "open").length;
      maxOpen = Math.max(maxOpen, open);
      if (guard % 6 === 0) { // the non-degradation check against the last checked snapshot, every sixth step (the load rule)
        const cur = JSON.parse(JSON.stringify(r.g.snapshot())) as SessionSnapshot;
        expect(sessionCoreSupersetViolation(cur, prev), `step ${guard}`).toBeNull();
        prev = cur;
      }
    }
    expect(created).toBeGreaterThan(OPEN_LEDGER_MAX_ENTRIES); // it made more entries than the bound over the season ...
    expect(maxOpen).toBeLessThan(OPEN_LEDGER_MAX_ENTRIES); // ... and the engine closed enough of them that the bound was never reached
    const statuses = new Set(priv(r.g).openLedger.entries.map((e) => `${e.status}:${e.note ?? ""}`));
    expect(statuses.has("withdrawn:left the house")).toBe(true);
    expect(priv(r.g).openLedger.entries.length).toBe(created);
  });
});


// ── ORW-448 review: M1, L1, L4 (pure) ────────────────────────────────────────────────────────────────────────────────────
describe("review M1: an entry linked to a deal that is still open never lapses (pure)", () => {
  const two = (): OpenLedger => led(
    entry({ id: "open:1", dealId: "deal:1", day: 1, quoteHash: "a" }),
    entry({ id: "open:2", day: 1, quoteHash: "b" }), // the unlinked twin
  );
  const stillOpen = (id: string) => (id === "deal:1" ? ("open" as const) : undefined);
  it("30 days on: the linked entry is open and in the brief; the unlinked twin lapsed on day 8 (7 days after day 1)", () => {
    const l = two();
    const d7 = syncOpenLedger(l, ctx({ day: 8, dealEnd: stillOpen }));
    expect(d7.entries.map((e) => e.status)).toEqual(["open", "lapsed"]);
    const d30 = syncOpenLedger(d7, ctx({ day: 31, dealEnd: stillOpen }));
    expect(d30.entries[0]!.status).toBe("open");
    expect(openLedgerSection(d30, ["npc:a"], (id) => id, 99)).toContain("I will vote with you");
    expect(syncOpenLedger(l, ctx({ day: 6, dealEnd: stillOpen })).entries.map((e) => e.status)).toEqual(["open", "open"]); // not before day 7
  });
  it("when that deal later ends, the entry closes with it; an unknown deal id counts as unlinked and lapses", () => {
    const l = syncOpenLedger(two(), ctx({ day: 31, dealEnd: stillOpen }));
    const ended = syncOpenLedger(l, ctx({ day: 32, dealEnd: () => "kept" }));
    expect(ended.entries[0]).toMatchObject({ status: "kept", note: "the linked deal ended as kept" });
    const unknown = syncOpenLedger(two(), ctx({ day: 8, dealEnd: () => undefined }));
    expect(unknown.entries[0]!.status).toBe("lapsed");
  });
});

describe("review L1: the note for a group entry does not say everyone left (pure)", () => {
  it("one houseguest -> 'left the house'; more than one houseguest among the parties -> 'one of them left the house'", () => {
    const l = led(
      entry({ id: "open:1", speaker: "npc:a", addressedTo: [ME] }),
      entry({ id: "open:2", speaker: "npc:b", addressedTo: [], parties: ["npc:b", "npc:a", ME], quoteHash: "g" }),
      entry({ id: "open:3", speaker: ME, addressedTo: ["npc:a", "npc:c"], quoteHash: "t" }),
    );
    const out = syncOpenLedger(l, ctx({ gone: new Set(["npc:a"]) }));
    expect(out.entries.map((e) => e.note)).toEqual(["left the house", "one of them left the house", "one of them left the house"]);
    expect(out.entries.every((e) => e.status === "withdrawn")).toBe(true);
  });
});

describe("review L4: with no in-game day nothing is stamped and nothing lapses (pure)", () => {
  it("no day -> unchanged; the day appears later -> first seen then, lapses 7 days after", () => {
    const l = led(entry());
    expect(syncOpenLedger(l, ctx())).toBe(l);
    expect(syncOpenLedger(l, ctx({ turn: 900 }))).toBe(l); // however late
    const first = syncOpenLedger(l, ctx({ day: 2 }));
    expect(first.touched).toEqual({ "open:1": 2 });
    expect(syncOpenLedger(first, ctx({ day: 8 }))).toBe(first);
    expect(syncOpenLedger(first, ctx({ day: 9 })).entries[0]!.status).toBe("lapsed");
  });
});

describe("review M2: which entries may link to a deal (pure)", () => {
  it("only a commitment word, as a whole word, case-insensitively, and never with `about`", () => {
    for (const kind of ["promise", "Promise", "a PACT", "secret deal", "final-four alliance", "their agreement", "vow", "oath", "pledge", "commitment", "promises", "deals", "promised", "agreed", "allied"]) {
      expect(openLedgerLinkable({ kind }), kind).toBe(true);
    }
    for (const kind of ["claim", "plan", "dealer", "dealership", "misdeal", "pledger", "alliancement", "compact", ""]) {
      expect(openLedgerLinkable({ kind }), kind).toBe(false);
    }
    expect(openLedgerLinkable({ kind: "promise", about: "npc:b" })).toBe(false);
  });
});

// ── ORW-448 review: M1/M2/L2 and the refused commit on the real engine ──────────────────────────────────────────────────
describe("review M2 (real engine): only a commitment-like entry with no `about` links to the deal", () => {
  function dealWith(): { g: GameSessionAdapter; who: string; other: string; dealId: string } {
    const { g } = startAtNominations();
    g.noteMessage({ messageId: "m-deal2" });
    const [who, other] = npcs(g);
    const made = g.makeDeal({ with: who as never, kind: "safety", terms: "a safe week" });
    if (!made || "refused" in made) throw new Error("the deal was not made");
    const wa = g.movePlayer("living-room")!;
    expect(wa.present.some((p) => p.id === who)).toBe(true);
    return { g, who: who!, other: other!, dealId: made.id };
  }
  const ent = (g: GameSessionAdapter, id?: string) => priv(g).openLedger.entries.find((e) => e.id === id)!;
  it("an unrelated claim (and a claim about a third person) two beats later does not link, and stays open when the deal ends kept", () => {
    const { g, who, other, dealId } = dealWith();
    priv(g).persist(); (g as unknown as { bumpBeatSeq(): void }).bumpBeatSeq(); (g as unknown as { bumpBeatSeq(): void }).bumpBeatSeq();
    const c1 = g.recordOpenLedger({ text: "I saw someone in the storage room", speaker: who, addressedTo: [ME], kind: "claim", about: other });
    const c2 = g.recordOpenLedger({ text: "the kitchen is a mess today", speaker: who, addressedTo: [ME], kind: "claim" });
    expect(ent(g, c1.entryId).dealId).toBeUndefined();
    expect(ent(g, c2.entryId).dealId).toBeUndefined();
    priv(g).deals.all.find((d) => d.id === dealId)!.status = "kept";
    priv(g).persist();
    expect(ent(g, c1.entryId).status).toBe("open");
    expect(ent(g, c2.entryId).status).toBe("open");
  });
  it("a 'promise' between the same two people inside the window links; with `about` set it never links", () => {
    const { g, who, other, dealId } = dealWith();
    const p = g.recordOpenLedger({ text: "I promise to keep you safe", speaker: who, addressedTo: [ME], kind: "promise" });
    expect(ent(g, p.entryId).dealId).toBe(dealId);
    const q = g.recordOpenLedger({ text: "I promise not to name you", speaker: who, addressedTo: [ME], kind: "promise", about: other });
    expect(ent(g, q.entryId).dealId).toBeUndefined();
    const r = g.recordOpenLedger({ text: "a dealer of rumours", speaker: who, addressedTo: [ME], kind: "dealer" });
    expect(ent(g, r.entryId).dealId).toBeUndefined();
  });
});

describe("review M1 (real engine): a linked entry survives 30 days while the deal is open; its unlinked twin lapses on day 7", () => {
  it("through the commit funnel", () => {
    const { g } = startAtNominations();
    g.noteMessage({ messageId: "m-m1" });
    const [who] = npcs(g);
    const made = g.makeDeal({ with: who as never, kind: "safety", terms: "a safe week" });
    if (!made || "refused" in made) throw new Error("the deal was not made");
    expect(g.movePlayer("living-room")!.present.some((p) => p.id === who)).toBe(true);
    const linked = g.recordOpenLedger({ text: "I promise to keep you safe", speaker: who!, addressedTo: [ME], kind: "promise" });
    const twin = g.recordOpenLedger({ text: "I like the pool", speaker: who!, addressedTo: [ME], kind: "claim" });
    const st = (id?: string) => priv(g).openLedger.entries.find((e) => e.id === id)!.status;
    if (priv(g).live.dayNumber === undefined) { priv(g).live.dayNumber = 1; priv(g).persist(); } // the day exists from here on: both entries are first seen then
    const base = priv(g).live.dayNumber!;
    priv(g).live.dayNumber = base + 7; priv(g).persist();
    expect([st(linked.entryId), st(twin.entryId)]).toEqual(["open", "lapsed"]);
    priv(g).live.dayNumber = base + 30; priv(g).persist();
    expect(st(linked.entryId)).toBe("open");
    // ORW-688: thirty days on, the house has moved on its own (a rumor now carries who it is about, so the off-screen tick plays differently); the speaker is brought back into the room first, since this checks the ledger's bound and not where they happen to be.
    const wa = g.whereabouts()!;
    // ORW-711: the living room has the bathroom and the lounge off it now, so on 30 days of drift the speaker may be behind one of those closed doors (not in view): fall back to the engine's own seat.
    const room = wa.present.some((p) => p.id === who) ? wa.room : (wa.nearby.find((r) => r.present.some((p) => p.id === who))?.room ?? (g as unknown as { presence: Map<string, string> }).presence.get(who as string));
    expect(room).toBeDefined();
    expect(g.movePlayer(room!)!.present.some((p) => p.id === who)).toBe(true);
    expect(g.openLedgerHere().some((x) => x.id === linked.entryId)).toBe(true);
  });
});

describe("review L2 (real engine): the veto used by a houseguest holder while the player is HOH flags the holder's entries, once", () => {
  it("flags with the veto result line; a second commit in the same state flags nothing more", () => {
    const { g } = startAtNominations();
    seedEntries(g);
    const [holder, saved] = npcs(g);
    const live = priv(g).live as unknown as Record<string, unknown>;
    Object.assign(live, { vetoUsed: true, saved, vetoHolder: holder, pending: { kind: "replacement" } });
    const record = (g as unknown as { recordAnnouncements(ev: null): void }).recordAnnouncements.bind(g);
    record(null);
    const want = priv(g).openLedger.entries.filter((e) => e.speaker === holder || e.addressedTo.includes(holder!)).map((e) => e.id).sort();
    expect(want.length).toBeGreaterThan(0);
    expect(dueIds(g)).toEqual(want);
    expect(Object.values(priv(g).openLedger.due!)[0]!.line).toMatch(/^Public result of the veto ceremony: /);
    for (const id of dueIds(g)) g.resolveOpenLedger({ entryId: id, status: "offered", note: "" }); // judged and dropped
    record(null); // the same ceremony again: nothing flags a second time
    expect(dueIds(g)).toEqual([]);
  });
});

describe("review: a REFUSED commit rolls the ledger back, and the next good commit applies the same changes once", () => {
  it("a refused nominations commit and a refused eviction commit (through the registry commit funnel)", () => {
    const a = startAtNominations(); // the run that gets refused
    const b = startAtNominations(); // an identical twin that never is
    const nameA = `orw448-${SEED}`;
    seedEntries(a.g); seedEntries(b.g);
    priv(a.g).persist(); priv(b.g).persist(); // commit the seeded ledger: it is the rollback baseline
    const cur = (): GameSessionAdapter => a.runtime.registry.sandboxFor(nameA).session as unknown as GameSessionAdapter;
    const ledgerJson = (g: GameSessionAdapter): string => JSON.stringify(priv(g).openLedger);
    const reg = a.runtime.registry as unknown as { saveUser(u: string): unknown };
    const realSave = reg.saveUser.bind(reg);
    const save = vi.spyOn(reg, "saveUser").mockImplementation((u: string) => realSave(u));
    let viewA = a.view; let viewB = b.view;
    let refusedChange = 0; let refusedEviction = 0; let guard = 0;
    while (guard++ < 600 && !priv(b.g).live.finished && refusedEviction < 1) {
      const beforeJson = ledgerJson(cur());
      const beforeOrder = priv(b.g).live.evictionOrder.length;
      const viewBefore = viewA;
      viewB = step(b.g, viewB); // the twin goes first to learn what this step would change
      const changes = ledgerJson(b.g) !== beforeJson;
      const evicts = priv(b.g).live.evictionOrder.length > beforeOrder;
      const refuse = changes && ((refusedChange === 0) || (evicts && refusedEviction === 0));
      if (!refuse) { viewA = step(cur(), viewA); expect(ledgerJson(cur())).toBe(ledgerJson(b.g)); continue; }
      save.mockImplementation(() => { throw new Error("disk"); });
      expect(() => step(cur(), viewBefore)).toThrow();
      save.mockImplementation((u: string) => realSave(u));
      cur().setAdvanceGateEnabled(false); // the rebuilt session starts with its defaults; the test's setup is re-applied
      (cur() as unknown as { setOwnViewEnabled(on: boolean): void }).setOwnViewEnabled(false); // ...all of it: the twin runs with the own view off (ORW-574, and ORW-634's referendum rides it)
      expect(ledgerJson(cur()), "rolled back to the pre-commit ledger").toBe(beforeJson);
      if (evicts) { refusedEviction++; for (const e of priv(cur()).openLedger.entries) expect(["open"]).toContain(e.status); } else refusedChange++;
      expect(priv(cur()).openLedger.due ?? {}).toEqual(JSON.parse(beforeJson).due ?? {});
      viewA = step(cur(), viewBefore); // the next good commit
      expect(ledgerJson(cur()), "the same changes, once").toBe(ledgerJson(b.g));
    }
    save.mockRestore();
    expect(refusedChange).toBe(1);
    expect(refusedEviction).toBe(1);
    const gone = priv(b.g).live.evictionOrder[0]!;
    const withdrawn = priv(cur()).openLedger.entries.filter((e) => e.status === "withdrawn");
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn.every((e) => e.note === "left the house" && (e.speaker === gone || e.addressedTo.includes(gone)))).toBe(true);
  });
});

describe("review L4 (real engine): a game with no day number stamps nothing and lapses nothing", () => {
  it("the week is not a stand-in; when the day appears the entry is first seen then", () => {
    const { g } = startAtNominations();
    delete priv(g).live.dayNumber; // a game whose first night has not passed: the counter does not exist yet
    const res = g.recordOpenLedger({ text: "a plan for the week", speaker: ME, addressedTo: [], kind: "plan", about: "the next competition" });
    const id = res.entryId!;
    const e = () => priv(g).openLedger.entries.find((x) => x.id === id)!;
    expect(e().day).toBeUndefined();
    priv(g).persist();
    expect(priv(g).openLedger.touched).toBeUndefined();
    expect(e().status).toBe("open");
    priv(g).live.dayNumber = 20; priv(g).persist();
    expect(priv(g).openLedger.touched).toEqual({ [id]: 20 });
    priv(g).live.dayNumber = 26; priv(g).persist();
    expect(e().status).toBe("open");
    priv(g).live.dayNumber = 27; priv(g).persist();
    expect(e().status).toBe("lapsed");
  });
});
