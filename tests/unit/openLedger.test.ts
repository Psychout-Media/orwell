import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { sessionCoreIsSuperset } from "../../src/engine/sessionSnapshot";
import { openLedgerProposal, OPEN_LEDGER_TEXT_MAX, OPEN_LEDGER_BRIEF_MAX } from "../../src/engine/openLedger";
import type { SessionSnapshot as SessionCore } from "../../src/engine/sessionSnapshot";

/**
 * ORW-407 slice 1 - the open ledger: a commitment or claim made to or by the player in narration is kept as free text
 * with provenance, survives a save, is shown back when that houseguest is present, is not duplicated, and changes no
 * relationship number. Roles only; the cast comes from a seed.
 */
type Priv = { openLedger: { entries: Array<Record<string, unknown>> } };

function played(seed = 11): GameSessionAdapter {
  const g = new GameSessionAdapter();
  g.createCharacter({ playerName: "The Player", seed });
  g.noteMessage({ messageId: `m-${seed}-1` });
  return g;
}
/** A houseguest who is in the player's room right now, moving the player to one if needed. */
function withCompanion(g: GameSessionAdapter): string {
  for (const room of ["living-room", "kitchen", "backyard", "bedroom", "bathroom"]) {
    const wa = g.movePlayer(room) ?? g.whereabouts();
    const who = wa?.present.find((p) => p.id !== g.getGameState().player?.id);
    if (who) return who.id as string;
  }
  throw new Error("no companion found");
}
const briefText = (g: GameSessionAdapter): string => g.getMomentPrompt({ brief: {} }).showBrief?.text ?? "";
const WORDS = "I promise I will never put you up on the block this week";
const req = (id: string, text = WORDS) => ({ text, speaker: id, addressedTo: ["player"], kind: "promise to protect" });

describe("openLedgerProposal (shape gate)", () => {
  const known = new Set(["npc:1", "npc:2"]);
  it("takes exactly four fields and a free-string kind", () => {
    const p = openLedgerProposal({ text: " a  b ", speaker: "npc:1", addressedTo: ["player"], kind: "made-up kind" }, known);
    expect(p).toEqual({ text: "a b", speaker: "npc:1", addressedTo: ["player"], kind: "made-up kind" });
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["player"] }, known)).toBe("bad-shape");
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["player"], kind: "k", extra: 1 }, known)).toBe("bad-shape");
  });
  it("rejects empty, long and unknown ids", () => {
    expect(openLedgerProposal({ text: " ", speaker: "npc:1", addressedTo: ["player"], kind: "k" }, known)).toBe("empty");
    expect(openLedgerProposal({ text: "x".repeat(OPEN_LEDGER_TEXT_MAX + 1), speaker: "npc:1", addressedTo: ["player"], kind: "k" }, known)).toBe("too-long");
    expect(openLedgerProposal({ text: "x", speaker: "npc:9", addressedTo: ["player"], kind: "k" }, known)).toBe("bad-speaker");
    expect(openLedgerProposal({ text: "x", speaker: "npc:1", addressedTo: ["npc:2"], kind: "k", parties: ["npc:9"] }, known)).toBe("bad-addressee");
  });
});

describe("recordOpenLedger (the adapter write-back)", () => {
  it("keeps an invented promise verbatim with provenance and witnesses", () => {
    const g = played();
    const id = withCompanion(g);
    const res = g.recordOpenLedger(req(id));
    expect(res).toMatchObject({ accepted: true });
    const e = (g as unknown as Priv).openLedger.entries[0]!;
    expect(e).toMatchObject({ text: WORDS, speaker: id, addressedTo: ["player"], kind: "promise to protect", status: "open" });
    expect(e.witnesses).toContain(id);
    expect(e.witnesses).toContain("player");
    expect(e.room).toBe(g.whereabouts()!.room);
    expect(typeof e.quoteHash).toBe("string");
    expect(typeof e.beatSeq).toBe("number");
  });

  it("is not duplicated on repetition", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    const again = g.recordOpenLedger(req(id, `  ${WORDS.toUpperCase()}  `));
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    expect((g as unknown as Priv).openLedger.entries.length).toBe(1);
  });

  it("survives a save and restore, and the save never thins", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    const snap = JSON.parse(JSON.stringify(g.snapshot())) as SessionCore;
    expect((snap as unknown as { openLedger: { entries: unknown[] } }).openLedger.entries.length).toBe(1);
    const h = new GameSessionAdapter();
    h.restore(snap);
    expect((h as unknown as Priv).openLedger.entries[0]).toMatchObject({ text: WORDS });
    const thinned = { ...snap } as SessionCore & { openLedger?: unknown };
    delete thinned.openLedger;
    expect(sessionCoreIsSuperset(thinned as SessionCore, snap)).toBe(false);
    expect(sessionCoreIsSuperset(snap, thinned as SessionCore)).toBe(true);
  });

  it("appears in the narrator's brief on a later turn only while that houseguest is present", () => {
    const g = played();
    const id = withCompanion(g);
    g.recordOpenLedger(req(id));
    expect(briefText(g)).toContain(`"${WORDS}"`);
    expect(briefText(g)).toMatch(/open between you and/);
    // move to a room where that houseguest is not
    const away = ["living-room", "kitchen", "backyard", "bedroom", "bathroom"].find((r) => {
      const wa = g.movePlayer(r) ?? g.whereabouts();
      return wa && !wa.present.some((p) => p.id === id);
    });
    if (away) expect(briefText(g)).not.toContain(WORDS);
  });

  it("refuses a speaker who is not present, and refuses when off, pre-game or headless", () => {
    const g = played();
    const id = withCompanion(g);
    const absent = g.getGameState().house.map((h) => h.id as string).find((x) => x !== id && x !== g.getGameState().player?.id && !g.whereabouts()!.present.some((p) => p.id === x));
    if (absent) expect(g.recordOpenLedger(req(absent)).reason).toBe("not-present");
    const off = played(4); off.setOpenLedgerEnabled(false);
    expect(off.recordOpenLedger(req("npc:1")).reason).toBe("off");
    expect(new GameSessionAdapter().recordOpenLedger(req("npc:1")).reason).toBe("no-game");
    const headless = new GameSessionAdapter();
    headless.createCharacter({ playerName: "The Player", seed: 3 });
    expect(headless.recordOpenLedger(req("npc:1")).reason).toBe("no-game");
    expect(JSON.stringify(headless.snapshot())).not.toContain("openLedger");
  });

  it("changes no game state and draws no randomness (only the openLedger key differs)", () => {
    const a = played(21);
    const b = played(21);
    const ia = withCompanion(a);
    const ib = withCompanion(b);
    expect(ib).toBe(ia);
    const seq = b.getGameState().beatSeq;
    b.recordOpenLedger(req(ib));
    expect(b.getGameState().beatSeq).toBe(seq);
    const strip = (g: GameSessionAdapter): string => { const s = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>; delete s.openLedger; return JSON.stringify(s); };
    expect(strip(b)).toBe(strip(a));
    expect(JSON.stringify(b.advanceGame())).toBe(JSON.stringify(a.advanceGame()));
  });
});

/* ---------------- slice 2: groups, claims about others, plans, resolution, the bound ---------------- */

/** The roles: two companions with the player in the living room, and one houseguest sent to the kitchen. */
function scene(g: GameSessionAdapter): { a: string; b: string; absent: string } {
  // the premiere seats the whole house together; get past it so houseguests can be elsewhere
  for (const h of g.getGameState().house) if (h.id !== g.getGameState().player?.id) g.markHouseguestMet(h.id);
  g.advanceGame(); g.advanceGame();
  g.movePlayer("living-room");
  const ids = g.whereabouts()!.present.map((p) => p.id as string).filter((x) => x !== g.getGameState().player?.id);
  const [a, b, absent] = [ids[0]!, ids[1]!, ids[2]!];
  g.recordHouseguestMove(absent, "kitchen");
  expect(g.whereabouts()!.present.some((p) => p.id === absent)).toBe(false);
  return { a, b, absent };
}
const moveTo = (g: GameSessionAdapter, id: string): void => {
  g.movePlayer("kitchen");
  if (!g.whereabouts()!.present.some((p) => p.id === id)) throw new Error("could not reach " + id);
};
const PACT = "If one of the three of us wins, the other two are safe, that is the deal";

describe("slice 2: group pacts", () => {
  it("stores a group pact once with all parties and surfaces it when any party is present", () => {
    const g = played(31);
    const { a, b } = scene(g);
    const r = g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "group safety pact", parties: [a, b, "player"] });
    expect(r).toMatchObject({ accepted: true });
    const again = g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "group safety pact", parties: [a, b, "player"] });
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    const entries = (g as unknown as Priv).openLedger.entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.parties).toEqual(expect.arrayContaining([a, b, "player"]));
    expect(briefText(g)).toContain(PACT);
    expect(g.openLedgerHere().map((x) => x.id)).toContain(entries[0]!.id);
  });

  it("surfaces for the second party alone, even when the speaker has left", () => {
    const g = played(31);
    const { a, b } = scene(g);
    g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "pact", parties: [a, b] });
    g.recordHouseguestMove(a, "kitchen");
    expect(g.whereabouts()!.present.some((p) => p.id === a)).toBe(false);
    expect(briefText(g)).toContain(PACT);
  });

  it("does not store a group whose member is not present or not in the house", () => {
    const g = played(31);
    const { a, absent } = scene(g);
    expect(g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "pact", parties: [a, absent] }).reason).toBe("not-present");
    expect(g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "pact", parties: [a, "npc:nobody"] }).reason).toBe("bad-addressee");
  });
});

describe("slice 2: claims about others and stated plans", () => {
  it("a claim about an absent houseguest surfaces when that houseguest later appears", () => {
    const g = played(31);
    const { a, absent } = scene(g);
    const words = "He has been telling everyone he will nominate whoever wins the next power";
    const r = g.recordOpenLedger({ text: words, speaker: a, addressedTo: [], kind: "claim about someone", about: absent });
    expect(r).toMatchObject({ accepted: true });
    expect(briefText(g).includes(words)).toBe(true); // speaker is here
    moveTo(g, absent);
    const wa = g.whereabouts()!;
    expect(wa.present.some((p) => p.id === absent)).toBe(true);
    const t = briefText(g);
    expect(t).toContain(words);
    expect(t).toMatch(/you heard .* say/);
  });

  it("keeps a free-text subject that is not a houseguest, and a plan with no addressee", () => {
    const g = played(31);
    const { a } = scene(g);
    g.recordOpenLedger({ text: "I am going to throw the next puzzle on purpose", speaker: a, addressedTo: [], kind: "stated plan", about: "the next competition" });
    const e = (g as unknown as Priv).openLedger.entries[0]!;
    expect(e).toMatchObject({ kind: "stated plan", about: "the next competition", addressedTo: [] });
    expect(briefText(g)).toContain("about the next competition");
  });
});

describe("slice 2: resolution", () => {
  it("an entry marked broken shows its status and note, and cannot be resolved twice", () => {
    const g = played(31);
    const { a } = scene(g);
    g.recordOpenLedger(req(a));
    const id = (g as unknown as Priv).openLedger.entries[0]!.id as string;
    expect(g.openLedgerHere().map((x) => x.id)).toEqual([id]);
    const res = g.resolveOpenLedger({ entryId: id, status: "broken", note: "she nominated the player anyway" });
    expect(res).toEqual({ accepted: true });
    const e = (g as unknown as Priv).openLedger.entries[0]!;
    expect(e).toMatchObject({ status: "broken", note: "she nominated the player anyway" });
    expect(typeof e.resolvedTurn).toBe("number");
    expect(briefText(g)).toContain("[broken: she nominated the player anyway]");
    expect(g.openLedgerHere()).toEqual([]);
    expect(g.resolveOpenLedger({ entryId: id, status: "kept", note: "x" }).reason).toBe("already-resolved");
    expect(g.resolveOpenLedger({ entryId: "open:99", status: "kept", note: "x" }).reason).toBe("unknown");
    expect(g.resolveOpenLedger({ entryId: id, status: "angry" as never, note: "x" }).reason).toBe("bad-status");
  });

  it("changes no relationship number (only the openLedger key differs)", () => {
    const a = played(31); const b = played(31);
    const sa = scene(a); const sb = scene(b);
    expect(sb.a).toBe(sa.a);
    b.recordOpenLedger(req(sb.a));
    b.resolveOpenLedger({ entryId: "open:1", status: "withdrawn", note: "took it back" });
    const strip = (g: GameSessionAdapter): string => { const s = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>; delete s.openLedger; return JSON.stringify(s); };
    expect(strip(b)).toBe(strip(a));
  });
});

describe("slice 2: save, headless, bound", () => {
  it("snapshot and restore keep parties, subject, status, note and turn", () => {
    const g = played(31);
    const { a, b, absent } = scene(g);
    g.recordOpenLedger({ text: PACT, speaker: a, addressedTo: [], kind: "pact", parties: [a, b] });
    g.recordOpenLedger({ text: "She is lying about the key", speaker: b, addressedTo: [], kind: "claim", about: absent });
    g.resolveOpenLedger({ entryId: "open:1", status: "kept", note: "the winner protected both" });
    const snap = JSON.parse(JSON.stringify(g.snapshot())) as SessionCore;
    const h = new GameSessionAdapter();
    h.restore(snap);
    const es = (h as unknown as Priv).openLedger.entries;
    expect(es[0]).toMatchObject({ parties: [a, b], status: "kept", note: "the winner protected both" });
    expect(typeof es[0]!.resolvedTurn).toBe("number");
    expect(es[1]).toMatchObject({ about: absent, status: "open" });
    expect(JSON.stringify(h.snapshot())).toBe(JSON.stringify(g.snapshot()));
  });

  it("headless runs carry no ledger and the new calls refuse", () => {
    const h = new GameSessionAdapter();
    h.createCharacter({ playerName: "The Player", seed: 5 });
    expect(h.openLedgerHere()).toEqual([]);
    expect(h.resolveOpenLedger({ entryId: "open:1", status: "kept", note: "" }).reason).toBe("no-game");
    expect(JSON.stringify(h.snapshot())).not.toContain("openLedger");
  });

  it("the surfaced list is bounded, most people here and most recent first", () => {
    const g = played(31);
    const { a, b } = scene(g);
    for (let i = 0; i < 12; i++) g.recordOpenLedger({ text: `solo claim number ${i}`, speaker: a, addressedTo: [], kind: "claim" });
    g.recordOpenLedger({ text: "a pact of two", speaker: a, addressedTo: [], kind: "pact", parties: [a, b] });
    const t = briefText(g);
    const lines = t.split("\n").filter((l) => l.startsWith("- open between") || l.startsWith("- you heard"));
    expect(lines.length).toBe(OPEN_LEDGER_BRIEF_MAX);
    expect(lines[0]).toContain("a pact of two"); // two people here outranks one
    expect(lines[1]).toContain("solo claim number 11"); // then newest
    expect(t).not.toContain("solo claim number 0\"");
    expect(g.openLedgerHere().length).toBeLessThanOrEqual(OPEN_LEDGER_BRIEF_MAX);
  });
});
