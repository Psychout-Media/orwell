import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CANON_BUDGET_PER_SCENE, CANON_SEASON_CAP, CANON_IDEMPOTENCY_KEEP, activeCanon, canonBriefLines, canonEntry,
  canonForCheck, canonHash, canonKeyTokens, canonSupersetProblems, emptyCanonLedger, noteCanonReferences,
  promoteCanon, recordCanon, restoreCanon, retireCanon, retireWeekCanon, selectBriefCanon, serializeCanon,
  supersedeCanon, type CanonLedger, type CanonPolicy,
} from "../../src/engine/canonLedger";
import type { CanonProposal, RecordCanonReq } from "../../src/domain/canon";
import { configuredForbiddenRules, cruisedModuleSources, forbiddenRulePatterns } from "../support/architecture";

/**
 * The canon ledger store (Showrunner memory Part B; K4 §2): the write path re-validates every proposal in code,
 * the read path selects what the brief may show, and nothing written is ever deleted. Roles only (npc:N, player);
 * every probe text is generic. Not wired into any session, tool or prompt yet.
 */

const SECRET = "SENTINEL-HIDDEN-7731"; // stands in for any Vault content
const policy: CanonPolicy = {
  leaksVault: (t) => t.includes(SECRET),
  forbiddenTerm: (t) => (/\b(hatch|tunnel|buried|note)\b/i.exec(t)?.[0]?.toLowerCase()),
  propCategoriesFor: (s) => (s.kind === "room"
    ? (s.room === "living-room" ? ["drinkware", "book-magazine"] : s.room === "diary-room" ? [] : ["drinkware"])
    : ["drinkware", "book-magazine", "jewelry-accessory"]),
  isHouseguest: (id) => /^npc:\d+$/.test(id),
};

const P = (over: Partial<CanonProposal> = {}): CanonProposal => ({
  text: "calls the hot tub 'the soup pot'",
  category: "nickname",
  scope: { kind: "houseguest", id: "npc:1" },
  speaker: "npc:1",
  witnesses: ["player", "npc:1"],
  room: "backyard",
  quote: "Last one in the soup pot buys dinner.",
  confidence: 0.9,
  ...over,
});
let keySeq = 0;
const R = (proposals: CanonProposal[], over: Partial<RecordCanonReq> = {}): RecordCanonReq => ({
  turn: 7, beatSeq: 100, sceneKey: "7", idempotencyKey: `session-a:${++keySeq}`, proposals, ...over,
});
const rec = (l: CanonLedger, proposals: CanonProposal[], over: Partial<RecordCanonReq> = {}, pol: CanonPolicy = policy) =>
  recordCanon(l, R(proposals, over), pol);
const reasons = (r: ReturnType<typeof recordCanon>) => r.result.results.map((x) => x.reason ?? x.outcome);

describe("recordCanon: a valid detail becomes binding canon with provenance", () => {
  it("records the detail with turn, houseguest, room, witnesses and the aired words", () => {
    const { ledger, result } = rec(emptyCanonLedger(), [P()]);
    expect(result.results).toEqual([{ index: 0, outcome: "recorded", entryId: "canon:1" }]);
    expect(result.budget).toEqual({ used: 1, max: 2 });
    const e = canonEntry(ledger, "canon:1")!;
    expect(e).toMatchObject({
      id: "canon:1", text: "calls the hot tub 'the soup pot'", category: "nickname",
      scope: { kind: "houseguest", id: "npc:1" }, persistence: "permanent", status: "active",
      lastReferencedBeatSeq: 100, referenceCount: 0,
      provenance: { turn: 7, beatSeq: 100, sceneKey: "7", speaker: "npc:1", witnesses: ["npc:1", "player"], room: "backyard",
        quote: "Last one in the soup pot buys dinner.", quoteHash: canonHash("Last one in the soup pot buys dinner.") },
    });
    expect(e.keyTokens).toEqual(["soup", "pot"]); // the quoted nickname is the anchor, not the thing it names
  });

  it("normalizes the stored text and keeps ids monotonic, never reused", () => {
    let l = emptyCanonLedger();
    l = rec(l, [P({ text: "  hoards   the lime\nseltzer ", category: "food-preference", quote: "Hands off my seltzer." })], { sceneKey: "1" }).ledger;
    l = rec(l, [P({ text: "stirs coffee counter-clockwise", category: "habit", quote: "Counter-clockwise, always." })], { sceneKey: "2" }).ledger;
    l = retireCanon(l, "canon:1").ledger;
    l = rec(l, [P({ text: "wears a braided bracelet", category: "personal-item", propCategory: "jewelry-accessory", quote: "My lucky bracelet." })], { sceneKey: "3" }).ledger;
    expect(l.entries.map((e) => e.id)).toEqual(["canon:1", "canon:2", "canon:3"]);
    expect(l.entries[0]!.text).toBe("hoards the lime seltzer");
    expect(l.nextId).toBe(4);
  });

  it("never mutates the ledger it is given", () => {
    const before = rec(emptyCanonLedger(), [P()]).ledger;
    const snapshot = JSON.stringify(before);
    rec(before, [P({ text: "always in the same faded cap", category: "wardrobe-style", quote: "The cap stays on." })]);
    noteCanonReferences(before, "the soup pot again", 120);
    retireCanon(before, "canon:1");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("defaults persistence by category and honours an explicit one", () => {
    const l = rec(emptyCanonLedger(), [
      P({ text: "'toll' is the word for an apology", category: "running-joke", scope: { kind: "house" }, quote: "That's a toll." }),
      P({ text: "keeps a paperback on the couch", category: "house-detail", scope: { kind: "room", room: "living-room" }, propCategory: "book-magazine", persistence: "week", quote: "Whose paperback?" }),
    ]).ledger;
    expect(l.entries.map((e) => e.persistence)).toEqual(["season", "week"]);
  });
});

describe("recordCanon: every rule is enforced in code (Decision 1)", () => {
  const rejectedFor = (p: CanonProposal) => reasons(rec(emptyCanonLedger(), [p]))[0];

  it("only proposable categories", () => {
    expect(rejectedFor(P({ category: "secret-fact" }))).toBe("bad-category");
    expect(rejectedFor(P({ category: "explained-hook" }))).toBe("bad-category"); // engine-written only
  });

  it("a real room or a real houseguest who was there", () => {
    expect(rejectedFor(P({ scope: { kind: "room", room: "cellar" as never } }))).toBe("bad-scope");
    expect(rejectedFor(P({ scope: { kind: "houseguest", id: "npc:2" } }))).toBe("bad-scope"); // not a witness
    expect(rejectedFor(P({ scope: { kind: "houseguest", id: "stranger" }, witnesses: ["stranger"] }))).toBe("bad-scope");
    expect(rejectedFor(P({ scope: { kind: "elsewhere" } as never }))).toBe("bad-scope");
    expect(rejectedFor(P({ room: "attic" as never }))).toBe("bad-scope");
    expect(rejectedFor(P({ category: "house-detail", propCategory: "drinkware" }))).toBe("bad-scope"); // a house detail is about a room
  });

  it("a known speaker", () => {
    expect(rejectedFor(P({ speaker: "somebody" }))).toBe("bad-speaker");
    expect(reasons(rec(emptyCanonLedger(), [P({ speaker: "narrator" })]))[0]).toBe("recorded");
  });

  it("text and quote shape", () => {
    expect(rejectedFor(P({ text: "   " }))).toBe("empty");
    expect(rejectedFor(P({ quote: "" }))).toBe("empty");
    expect(rejectedFor(P({ text: "x".repeat(141) }))).toBe("too-long");
    expect(rejectedFor(P({ quote: "y".repeat(141) }))).toBe("too-long");
  });

  it("never an engine-only thing: the lexicon, relationship or knowledge words, any number", () => {
    expect(rejectedFor(P({ text: "keeps a note in the hatch" }))).toBe("lexicon");
    expect(rejectedFor(P({ quote: "Did you see the tunnel?" }))).toBe("lexicon");
    for (const text of ["secretly trusts the other houseguest", "knows that the vote is set", "plans to target a nominee", "has won 3 comps"]) {
      expect(rejectedFor(P({ text })), text).toBe("forbidden-class");
    }
  });

  it("a house detail or personal item needs a prop category the scope allows", () => {
    const hd = { category: "house-detail", scope: { kind: "room" as const, room: "living-room" as const } };
    expect(reasons(rec(emptyCanonLedger(), [P({ ...hd, text: "a paperback lives on the couch", propCategory: "book-magazine" })]))[0]).toBe("recorded");
    expect(rejectedFor(P({ ...hd, text: "a towel on the couch", propCategory: "towel-linen" }))).toBe("prop-not-allowed");
    expect(rejectedFor(P({ ...hd, text: "a towel on the couch" }))).toBe("prop-not-allowed");
    expect(rejectedFor(P({ category: "house-detail", scope: { kind: "room", room: "diary-room" }, text: "a mug by the chair", propCategory: "drinkware" }))).toBe("prop-not-allowed");
    expect(rejectedFor(P({ category: "personal-item", text: "wears a lucky ring" }))).toBe("prop-not-allowed");
  });

  it("the confidence floor", () => {
    expect(rejectedFor(P({ confidence: 0.4 }))).toBe("low-confidence");
    expect(rejectedFor(P({ confidence: Number.NaN }))).toBe("low-confidence");
  });

  it("the Vault sweep: rejected, never persisted, never echoed", () => {
    const r = rec(emptyCanonLedger(), [P({ text: `mentions ${SECRET} a lot` }), P({ text: "hums while cooking", category: "habit", quote: `Humming ${SECRET}` })]);
    expect(reasons(r)).toEqual(["vault-overlap", "vault-overlap"]);
    expect(r.ledger.entries).toEqual([]);
    expect(JSON.stringify(r.result)).not.toContain(SECRET);
    expect(JSON.stringify(r.ledger)).not.toContain(SECRET);
  });

  it("no duplicates: the same aired words, or the same text in the same scope, or twice in one call", () => {
    const first = rec(emptyCanonLedger(), [P()], { sceneKey: "1" }).ledger;
    expect(reasons(rec(first, [P({ text: "a different text" })], { sceneKey: "2" }))[0]).toBe("duplicate"); // same quote
    expect(reasons(rec(first, [P({ quote: "Different words entirely." })], { sceneKey: "2" }))[0]).toBe("duplicate"); // same text, scope
    expect(reasons(rec(emptyCanonLedger(), [P(), P()]))).toEqual(["recorded", "duplicate"]);
    // The same text about someone else is a different detail.
    expect(reasons(rec(first, [P({ scope: { kind: "houseguest", id: "npc:2" }, witnesses: ["npc:2", "player"], quote: "Soup pot, again." })], { sceneKey: "2" }))[0]).toBe("recorded");
  });

  it("a proposal that contradicts an active entry is refused", () => {
    const first = rec(emptyCanonLedger(), [P()]).ledger;
    expect(reasons(rec(first, [P({ text: "calls the hot tub 'the bathtub'", quote: "The bathtub is warm.", contradicts: "canon:1" })], { sceneKey: "8" }))[0]).toBe("contradicts-canon");
    const retired = retireCanon(first, "canon:1").ledger;
    expect(reasons(rec(retired, [P({ text: "calls the hot tub 'the bathtub'", quote: "The bathtub is warm.", contradicts: "canon:1" })], { sceneKey: "8" }))[0]).toBe("recorded");
  });
});

describe("recordCanon: budget, season cap, idempotency", () => {
  const three = [
    P({ text: "hums while cooking", category: "habit", quote: "Hum hum.", confidence: 0.7 }),
    P({ text: "calls the yard 'the beach'", quote: "To the beach.", confidence: 0.9 }),
    P({ text: "always in the same faded cap", category: "wardrobe-style", quote: "The cap stays.", confidence: 0.9 }),
  ];

  it(`records at most ${CANON_BUDGET_PER_SCENE} per scene, ranked by confidence then category`, () => {
    const r = rec(emptyCanonLedger(), three);
    // 0.9 nickname, 0.9 wardrobe-style (nickname ranks first), then the 0.7 habit runs out of budget.
    expect(reasons(r)).toEqual(["budget", "recorded", "recorded"]);
    expect(r.result.budget).toEqual({ used: 2, max: 2 });
    expect(r.ledger.entries.map((e) => e.category)).toEqual(["nickname", "wardrobe-style"]);
  });

  it("the budget counts across calls in the same scene and resets in the next one", () => {
    const a = rec(emptyCanonLedger(), [three[0]!], { sceneKey: "9" });
    const b = rec(a.ledger, [three[1]!, three[2]!], { sceneKey: "9" });
    expect(reasons(b)).toEqual(["recorded", "budget"]);
    expect(reasons(rec(b.ledger, [three[2]!], { sceneKey: "10" }))).toEqual(["recorded"]);
  });

  it("the budget is tunable (Decision 1b)", () => {
    expect(reasons(rec(emptyCanonLedger(), three, {}, { ...policy, budgetPerScene: 3 }))).toEqual(["recorded", "recorded", "recorded"]);
    expect(reasons(rec(emptyCanonLedger(), three, {}, { ...policy, budgetPerScene: 0 }))).toEqual(["budget", "budget", "budget"]);
  });

  it(`stops at the season cap of ${CANON_SEASON_CAP} active entries; a retired entry frees a slot`, () => {
    const small = { ...policy, seasonCap: 2, budgetPerScene: 5 };
    const full = rec(emptyCanonLedger(), three.slice(1), { sceneKey: "1" }, small).ledger;
    expect(reasons(rec(full, [three[0]!], { sceneKey: "2" }, small))).toEqual(["season-cap"]);
    const freed = retireCanon(full, "canon:1").ledger;
    expect(reasons(rec(freed, [three[0]!], { sceneKey: "2" }, small))).toEqual(["recorded"]);
  });

  it("a replayed idempotency key records nothing and returns the first result (two windows, a retry)", () => {
    const req = R([P()]);
    const first = recordCanon(emptyCanonLedger(), req, policy);
    const again = recordCanon(first.ledger, req, policy);
    expect(again.replay).toBe(true);
    expect(again.ledger).toBe(first.ledger);
    expect(again.result).toEqual(first.result);
    expect(activeCanon(again.ledger)).toHaveLength(1);
  });

  it("keeps a bounded idempotency window", () => {
    let l = emptyCanonLedger();
    for (let i = 0; i < CANON_IDEMPOTENCY_KEEP + 5; i++) l = recordCanon(l, R([], { idempotencyKey: `k${i}` }), policy).ledger;
    expect(l.recent).toHaveLength(CANON_IDEMPOTENCY_KEEP);
    expect(l.recent[0]!.key).toBe("k5");
  });
});

describe("references and status transitions (never a deletion)", () => {
  const base = rec(emptyCanonLedger(), [
    P(),
    P({ text: "'toll' is the word for an apology", category: "running-joke", scope: { kind: "house" }, quote: "That's a toll.", confidence: 0.8 }),
  ]).ledger;

  it("a reference is a whole-word match on most of the anchors; it moves the counters forward", () => {
    const l = noteCanonReferences(base, "Everyone piles into the soup pot.", 140);
    expect(canonEntry(l, "canon:1")).toMatchObject({ referenceCount: 1, lastReferencedBeatSeq: 140 });
    expect(canonEntry(l, "canon:2")).toMatchObject({ referenceCount: 0, lastReferencedBeatSeq: 100 });
    expect(noteCanonReferences(base, "Nothing relevant here at all.", 140)).toBe(base);
    expect(noteCanonReferences(base, "soupy potatoes", 140)).toBe(base); // not whole words
  });

  it("retire, supersede and promote move status forward and keep the entry", () => {
    expect(retireCanon(base, "canon:1").ledger.entries[0]!.status).toBe("retired");
    expect(retireCanon(base, "canon:9")).toMatchObject({ ok: false, reason: "unknown-entry" });
    const retired = retireCanon(base, "canon:1").ledger;
    expect(retireCanon(retired, "canon:1")).toMatchObject({ ok: false, reason: "not-active" });

    const sup = supersedeCanon(base, "canon:1", "canon:2");
    expect(sup.ok).toBe(true);
    expect(canonEntry(sup.ledger, "canon:1")).toMatchObject({ status: "superseded", supersededBy: "canon:2" });
    expect(supersedeCanon(base, "canon:1", "canon:1")).toMatchObject({ ok: false, reason: "bad-target" });
    expect(supersedeCanon(base, "canon:1", "canon:7")).toMatchObject({ ok: false, reason: "bad-target" });

    const pro = promoteCanon(base, "canon:2", "bit:3");
    expect(canonEntry(pro.ledger, "canon:2")).toMatchObject({ status: "promoted", promotedTo: { kind: "bit", id: "bit:3" } });
    expect(promoteCanon(base, "canon:2", "  ")).toMatchObject({ ok: false, reason: "bad-target" });
    const habit = rec(emptyCanonLedger(), [P({ text: "hums while cooking", category: "habit", quote: "Hum." })]).ledger;
    expect(promoteCanon(habit, "canon:1", "bit:1")).toMatchObject({ ok: false, reason: "not-promotable" });
    for (const l of [sup.ledger, pro.ledger, retired]) expect(l.entries).toHaveLength(2);
  });

  it("the weekly boundary retires week-scoped details only", () => {
    const l = rec(base, [P({ text: "a mug lives on the counter", category: "house-detail", scope: { kind: "room", room: "kitchen" }, propCategory: "drinkware", persistence: "week", quote: "My mug." })], { sceneKey: "w" }).ledger;
    const after = retireWeekCanon(l);
    expect(after.entries.map((e) => e.status)).toEqual(["active", "active", "retired"]);
    expect(retireWeekCanon(after)).toBe(after);
  });
});

describe("the read path: what the brief may show (K4 §2.6-§2.7)", () => {
  const l = rec(emptyCanonLedger(), [
    P(), // npc:1, permanent nickname, beat 100
    P({ text: "'toll' is the word for an apology", category: "running-joke", scope: { kind: "house" }, quote: "That's a toll." }),
  ], { sceneKey: "1" }).ledger;
  const l2 = rec(l, [
    P({ text: "a paperback lives on the couch", category: "house-detail", scope: { kind: "room", room: "living-room" }, propCategory: "book-magazine", quote: "Whose paperback?" }),
    P({ text: "a mug lives on the counter", category: "house-detail", scope: { kind: "room", room: "kitchen" }, propCategory: "drinkware", persistence: "week", quote: "My mug." }),
  ], { sceneKey: "2", beatSeq: 110 }).ledger;
  const ctx = { room: "living-room" as const, adjacentRooms: ["kitchen" as const], presentIds: ["npc:1"], beatSeq: 120 };

  it("shows in-scope active details, permanent-and-here first, then most recently referenced", () => {
    expect(selectBriefCanon(l2, ctx).map((e) => e.id)).toEqual(["canon:1", "canon:3", "canon:4", "canon:2"]);
  });

  it("a houseguest's detail shows only while that houseguest is present (ADR 0019)", () => {
    expect(selectBriefCanon(l2, { ...ctx, presentIds: [] }).map((e) => e.id)).not.toContain("canon:1");
  });

  it("rooms beyond next door are out of scope", () => {
    expect(selectBriefCanon(l2, { ...ctx, room: "backyard", adjacentRooms: [] }).map((e) => e.id)).toEqual(["canon:1", "canon:2"]);
  });

  it("fades unreferenced details (week-scoped faster), never a permanent one that is here, and a reference revives", () => {
    const late = { ...ctx, beatSeq: 145 }; // 35 past the house details, 45 past the first two
    expect(selectBriefCanon(l2, late).map((e) => e.id)).toEqual(["canon:1", "canon:3"]);
    const revived = noteCanonReferences(l2, "the toll again", 145);
    expect(selectBriefCanon(revived, late).map((e) => e.id)).toEqual(["canon:1", "canon:2", "canon:3"]);
    // Fading leaves the brief, not the ledger: the faded entries are still binding.
    expect(activeCanon(l2)).toHaveLength(4);
  });

  it("caps the brief and never shows a quote", () => {
    expect(selectBriefCanon(l2, ctx, { max: 2 })).toHaveLength(2);
    const lines = canonBriefLines(selectBriefCanon(l2, ctx));
    for (const e of l2.entries) for (const line of lines) expect(line).not.toContain(e.provenance.quote);
  });

  it("the after-turn check gets every active entry, most recently referenced first, capped", () => {
    expect(canonForCheck(l2).map((e) => e.id)).toEqual(["canon:3", "canon:4", "canon:1", "canon:2"]);
    expect(canonForCheck(l2, 1)).toHaveLength(1);
    expect(canonForCheck(retireCanon(l2, "canon:3").ledger).map((e) => e.id)).not.toContain("canon:3");
  });
});

describe("persistence and the non-degradation rule (K4 §2.5)", () => {
  const l = noteCanonReferences(rec(emptyCanonLedger(), [P(), P({ text: "hums while cooking", category: "habit", quote: "Hum." })]).ledger, "soup pot", 130);

  it("round-trips byte-identically", () => {
    const back = restoreCanon(serializeCanon(l));
    expect(back.problems).toEqual([]);
    expect(serializeCanon(back.ledger)).toEqual(serializeCanon(l));
    expect(JSON.stringify(serializeCanon(back.ledger))).toBe(JSON.stringify(serializeCanon(l)));
  });

  it("a pre-feature save is an empty ledger with nothing to report", () => {
    expect(restoreCanon(undefined)).toEqual({ ledger: emptyCanonLedger(), problems: [] });
  });

  it("reports (never silently drops) malformed data, and repairs nextId past the highest id", () => {
    const raw = serializeCanon(l) as unknown as { entries: unknown[]; nextId: number; schemaVersion: number };
    const bad = { ...raw, schemaVersion: 2, nextId: 1, entries: [...raw.entries, { id: "canon:x" }, raw.entries[0]] };
    const r = restoreCanon(bad);
    expect(r.problems).toEqual([
      "canon: unknown schemaVersion 2", "canon entry 2: bad id", "canon entry 3: duplicate id canon:1", "canon: nextId repaired past the highest id",
    ]);
    expect(r.ledger.entries.map((e) => e.id)).toEqual(["canon:1", "canon:2"]);
    expect(r.ledger.nextId).toBe(3);
    expect(restoreCanon("junk").problems).toEqual(["canon: not an object"]);
    expect(restoreCanon({ schemaVersion: 1, nextId: 1, entries: "nope" }).problems).toContain("canon: entries is not a list");
  });

  it("the restored ledger is a copy (mutating the raw save cannot reach it)", () => {
    const raw = serializeCanon(l) as unknown as { entries: Array<{ text: string }> };
    const back = restoreCanon(raw).ledger;
    raw.entries[0]!.text = "changed";
    expect(back.entries[0]!.text).toBe("calls the hot tub 'the soup pot'");
  });

  it("accepts only forward moves: new entries, counters up, status out of active, set-once links", () => {
    let next = rec(l, [P({ text: "always in the same faded cap", category: "wardrobe-style", quote: "Cap." })], { sceneKey: "z" }).ledger;
    next = noteCanonReferences(next, "the faded cap", 150);
    next = supersedeCanon(next, "canon:2", "canon:3").ledger;
    expect(canonSupersetProblems(l, next)).toEqual([]);
  });

  it("flags a removal, a changed byte-stable field (even a nested one), a status reset, counters going back", () => {
    const removed: CanonLedger = { ...l, entries: l.entries.slice(1) };
    expect(canonSupersetProblems(l, removed)).toEqual(["canon:1 was removed"]);
    const edited: CanonLedger = { ...l, entries: [{ ...l.entries[0]!, text: "something else" }, l.entries[1]!] };
    expect(canonSupersetProblems(l, edited)).toEqual(["canon:1 changed a byte-stable field"]);
    const nested: CanonLedger = { ...l, entries: [{ ...l.entries[0]!, provenance: { ...l.entries[0]!.provenance, turn: 99 } }, l.entries[1]!] };
    expect(canonSupersetProblems(l, nested)).toEqual(["canon:1 changed a byte-stable field"]);
    const retired = retireCanon(l, "canon:1").ledger;
    const reset: CanonLedger = { ...retired, entries: [{ ...retired.entries[0]!, status: "active" }, retired.entries[1]!] };
    expect(canonSupersetProblems(retired, reset)).toEqual(["canon:1 status moved retired -> active"]);
    const back: CanonLedger = { ...l, nextId: 1, entries: [{ ...l.entries[0]!, referenceCount: 0, lastReferencedBeatSeq: 1 }, l.entries[1]!] };
    expect(canonSupersetProblems(l, back)).toEqual([
      "canon nextId went back (3 -> 1)", "canon:1 referenceCount went back", "canon:1 lastReferencedBeatSeq went back",
    ]);
    const sup = supersedeCanon(l, "canon:1", "canon:2").ledger;
    const relinked: CanonLedger = { ...sup, entries: [{ ...sup.entries[0]!, supersededBy: "canon:9" }, sup.entries[1]!] };
    expect(canonSupersetProblems(sup, relinked)).toEqual(["canon:1 supersededBy changed"]);
    const pro = promoteCanon(l, "canon:1", "bit:1").ledger;
    const reprom: CanonLedger = { ...pro, entries: [{ ...pro.entries[0]!, promotedTo: { kind: "bit", id: "bit:2" } }, pro.entries[1]!] };
    expect(canonSupersetProblems(pro, reprom)).toEqual(["canon:1 promotedTo changed"]);
  });
});

describe("seeded random operation sequences (property-style)", () => {
  /** mulberry32: a tiny deterministic PRNG for the test driver only. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const words = ["soup", "pot", "beach", "cap", "seltzer", "mug", "paperback", "hum", "toll", "lime", "towel", "hammock"];
  const cats = ["habit", "catchphrase", "nickname", "running-joke", "wardrobe-style", "food-preference", "house-detail", "personal-item", "bogus"];

  it("never exceeds the per-scene budget, never deletes, keeps ids monotonic, and every step is a superset", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      let l = emptyCanonLedger();
      for (let step = 0; step < 60; step++) {
        const before = l;
        const op = r();
        if (op < 0.6) {
          const n = Math.floor(r() * 4);
          const proposals = Array.from({ length: n }, () => {
            const w = `${pick(words)} ${pick(words)}`;
            const cat = pick(cats);
            return P({
              text: `likes the ${w}`, quote: `About the ${w}, ${Math.floor(r() * 5)}.`, category: cat,
              scope: cat === "house-detail" ? { kind: "room", room: "living-room" } : r() < 0.5 ? { kind: "house" } : { kind: "houseguest", id: "npc:1" },
              propCategory: r() < 0.8 ? "book-magazine" : undefined, confidence: 0.5 + r() * 0.5,
            });
          });
          l = recordCanon(l, R(proposals, { sceneKey: String(Math.floor(step / 3)), beatSeq: 100 + step }), policy).ledger;
        } else if (op < 0.75) l = noteCanonReferences(l, `the ${pick(words)} and the ${pick(words)}`, 100 + step);
        else if (op < 0.85 && l.entries.length) l = retireCanon(l, pick(l.entries).id).ledger;
        else if (op < 0.95 && l.entries.length > 1) l = supersedeCanon(l, pick(l.entries).id, pick(l.entries).id).ledger;
        else l = retireWeekCanon(l);

        expect(canonSupersetProblems(before, l), `seed ${seed} step ${step}`).toEqual([]);
        const perScene = new Map<string, number>();
        for (const e of l.entries) perScene.set(e.provenance.sceneKey, (perScene.get(e.provenance.sceneKey) ?? 0) + 1);
        for (const n of perScene.values()) expect(n).toBeLessThanOrEqual(CANON_BUDGET_PER_SCENE);
        const ids = l.entries.map((e) => Number(e.id.slice(6)));
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(new Set(ids).size).toBe(ids.length);
        expect(l.nextId).toBeGreaterThan(Math.max(0, ...ids));
        expect(JSON.stringify(restoreCanon(serializeCanon(l)).ledger)).toBe(JSON.stringify(restoreCanon(serializeCanon(l)).ledger));
      }
    }
  });
});

describe("structure", () => {
  it("anchor words prefer the quoted phrase, skip names and stopwords, and are deterministic", () => {
    expect(canonKeyTokens("Someone calls the hot tub 'the soup pot'")).toEqual(["soup", "pot"]);
    expect(canonKeyTokens("Someone stirs coffee counter-clockwise")).toEqual(["stirs", "coffee", "counter-clockwise"]);
    expect(canonKeyTokens("hoards the lime seltzer")).toEqual(["hoards", "lime", "seltzer"]);
    expect(canonKeyTokens("the a an")).toEqual(["the"]);
    expect(canonKeyTokens("")).toEqual([]);
    expect(canonHash("Soup  pot")).toBe(canonHash("soup pot"));
  });

  it("the dependency-cruiser rule guarding the ledger is configured and matches both ledger modules (not vacuous)", async () => {
    expect(configuredForbiddenRules()).toContain("no-vault-in-canon-ledger");
    const { from, to } = forbiddenRulePatterns("no-vault-in-canon-ledger");
    const modules = await cruisedModuleSources();
    expect(modules.filter((m) => new RegExp(from!).test(m)).sort()).toEqual(["src/domain/canon.ts", "src/engine/canonLedger.ts"]);
    expect(modules.filter((m) => new RegExp(to!).test(m)).length).toBeGreaterThan(0);
  }, 60_000);

  it("is Vault-free by construction: the ledger and its types import no hidden-state module", () => {
    for (const f of ["src/engine/canonLedger.ts", "src/domain/canon.ts"]) {
      const src = readFileSync(f, "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/Vault|VectorIndex|SoulProvider|soul|relationship/i);
    }
  });
});
